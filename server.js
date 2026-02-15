const WebSocket = require('ws');
const fetch = require('node-fetch');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000; 

// --- CONFIGURAÇÕES ---
const TG_TOKEN = "8427077212:AAEiL_3_D_-fukuaR95V3FqoYYyHvdCHmEI"; 
const TG_CHAT_ID = "-1003355965894"; 
const LINK_CORRETORA = "https://track.deriv.com/_S_W1N_"; 

let fin = { bancaInicial: 0, bancaAtual: 0, payout: 0.95, percentual: 0.01 }; 
let stats = { winDireto: 0, winG1: 0, winG2: 0, loss: 0, totalAnalises: 0 };
let motores = {};

// --- AUXILIARES TÉCNICOS ---
function getEMA(list, period = 20) {
    if (list.length < period) return 0;
    const k = 2 / (period + 1);
    let ema = list[0].close;
    for (let i = 1; i < list.length; i++) { ema = (list[i].close * k) + (ema * (1 - k)); }
    return ema;
}

function obterHorarios() {
    const agora = new Date();
    const inicio = agora.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const fim = new Date(agora.getTime() + 60000).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    return { inicio, fim };
}

// --- FUNÇÃO DE MENSAGEM PADRONIZADA (BRAIN PRO) ---
function gerarTextoBase(m, status, extra = "") {
    const h = obterHorarios();
    const totalWins = stats.winDireto + stats.winG1 + stats.winG2;
    
    let msg = `🚀 *BRAIN PRO: ${status}*\n\n`;
    
    // 1. 👉 Clique agora! acima de Ativo (apenas em entradas e gales)
    if (status.includes("ENTRADA") || status.includes("GALE")) {
        msg += `👉Clique agora!\n`;
    }

    msg += `📊 Ativo: ${m.nome}\n` +
           `🎯 Padrão: ${m.op.est || "ANALISANDO"}\n` +
           `📈 Direção: ${m.op.dir || "---"}\n\n` +
           `${extra}`;
    
    // 2. Mostrar horários apenas se NÃO for GREEN ou RED
    if (!status.includes("GREEN") && !status.includes("RED")) {
        msg += `⏰ Início: ${h.inicio}\n` +
               `🏁 Fim: ${h.fim}\n\n`;
    }

    msg += `🏆 Placar: ${totalWins}W | ${stats.loss}L\n` +
           `💰 Banca: R$ ${fin.bancaAtual.toFixed(2)}`;
           
    return msg;
}

// --- ROTA DE CONFIGURAÇÃO ---
app.post('/config-financeira', (req, res) => {
    const { banca, payout } = req.body;
    if (banca !== undefined) {
        fin.bancaInicial = Number(banca);
        fin.bancaAtual = Number(banca); 
        console.log(`>>> SALVANDO: Banca R$ ${fin.bancaInicial}`);
    }
    if (payout !== undefined) fin.payout = Number(payout) / 100;
    res.json({ success: true, fin });
});

app.get('/status', (req, res) => {
    const lucroReal = fin.bancaInicial > 0 ? (fin.bancaAtual - fin.bancaInicial) : 0;
    const totalWins = stats.winDireto + stats.winG1 + stats.winG2;
    const totalOps = totalWins + stats.loss;
    
    res.json({
        global: { 
            winDireto: stats.winDireto, winGales: (stats.winG1 + stats.winG2), loss: stats.loss, 
            banca: fin.bancaAtual.toFixed(2), lucro: lucroReal.toFixed(2), 
            precisao: (totalOps > 0 ? (totalWins / totalOps * 100) : 0).toFixed(1) 
        },
        ativos: Object.keys(motores).map(id => ({
            cardId: id, nome: motores[id].nome, preco: motores[id].preco, 
            status: motores[id].op.ativa ? "OPERANDO" : "ANALISANDO",
            forca: motores[id].forca || 50
        }))
    });
});

function enviarTelegram(msg) {
    let payload = { chat_id: TG_CHAT_ID, text: msg, parse_mode: "Markdown", 
    reply_markup: { inline_keyboard: [[{ text: "📲 PREPARAR NA CORRETORA", url: LINK_CORRETORA }]] }};
    fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }).catch(e => {});
}

function analyzeCandlePatterns(list) {
    if(list.length < 5) return null;
    const last = list[list.length - 1];
    const prev = list[list.length - 2];
    const body = Math.abs(last.close - last.open);
    const upperWick = last.high - Math.max(last.open, last.close);
    const lowerWick = Math.min(last.open, last.close) - last.low;

    if (lowerWick > body * 2 && upperWick < body * 0.5) return { name: "MARTELO", dir: "CALL" };
    if (upperWick > body * 2 && lowerWick < body * 0.5) return { name: "ESTRELA", dir: "PUT" };
    if (last.close > last.open && prev.open > prev.close && last.close > prev.open) return { name: "ENGOLFO ALTA", dir: "CALL" };
    if (last.open > last.close && prev.close > prev.open && last.close < prev.open) return { name: "ENGOLFO BAIXA", dir: "PUT" };
    return null;
}

// --- MOTOR DE OPERAÇÕES ---
function iniciarMotor(cardId, ativoId, nomeAtivo) {
    if (motores[cardId]?.ws) motores[cardId].ws.terminate();
    if (ativoId === "OFF") return;

    let m = {
        nome: nomeAtivo, alertado: false, history: [], historyM5: [],
        ws: new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089'),
        preco: "0.0000", op: { ativa: false, est: "", pre: 0, t: 0, dir: "", g: 0, val: 0 }
    };

    m.ws.on('open', () => {
        m.ws.send(JSON.stringify({ ticks_history: ativoId, end: "latest", count: 60, style: "candles", granularity: 60, subscribe: 1 }));
        m.ws.send(JSON.stringify({ ticks_history: ativoId, end: "latest", count: 5, style: "candles", granularity: 300, subscribe: 1, req_id: "validaM5" }));
    });

    m.ws.on('message', (data) => {
        const res = JSON.parse(data.toString());
        if (res.candles && !res.req_id) m.history = res.candles;
        if (res.candles && res.req_id === "validaM5") m.historyM5 = res.candles;

        if (res.ohlc) {
            const ohlc = res.ohlc;
            if(ohlc.granularity === 300) { 
                const lastM5 = m.historyM5[m.historyM5.length - 1];
                if(lastM5) { lastM5.close = ohlc.close; lastM5.open = ohlc.open; }
                return; 
            }

            m.preco = parseFloat(ohlc.close).toFixed(5);
            const s = new Date().getSeconds();
            const uM5 = m.historyM5[m.historyM5.length - 1];
            const tendM5 = uM5 ? (uM5.close >= uM5.open ? "CALL" : "PUT") : null;
            const ema20 = getEMA(m.history, 20);

            // 3. Alerta Atualizado: Horário dinâmico e Clique Agora
            if (s >= 50 && s <= 55 && !m.op.ativa && !m.alertado) {
                const pattern = analyzeCandlePatterns([...m.history, { open: ohlc.open, close: ohlc.close, high: ohlc.high, low: ohlc.low }]);
                const emaOk = pattern ? (pattern.dir === "CALL" ? ohlc.close > ema20 : ohlc.close < ema20) : false;
                if (pattern && pattern.dir === tendM5 && emaOk) {
                    const hEntrada = new Date(new Date().getTime() + (60 - s) * 1000).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
                    enviarTelegram(`🔔 *ALERTA BRAIN PRO*\n\n👉Clique agora!\n📊 Ativo: ${m.nome}\n🎯 Padrão: ${pattern.name}\n📈 Direção: ${pattern.dir}\n🔍 M5+EMA: ✅\n\n🕓 Entrada às: ${hEntrada}`);
                    m.alertado = true;
                }
            }

            // ENTRADA
            if (s === 0 && !m.op.ativa) {
                m.alertado = false;
                const pattern = analyzeCandlePatterns(m.history);
                const emaOk = pattern ? (pattern.dir === "CALL" ? m.history[m.history.length-1].close > ema20 : m.history[m.history.length-1].close < ema20) : false;
                if (pattern && pattern.dir === tendM5 && emaOk) {
                    let valorEntrada = fin.bancaInicial * fin.percentual;
                    if(fin.bancaAtual >= valorEntrada){
                        fin.bancaAtual -= valorEntrada;
                        m.op = { ativa: true, est: pattern.name, pre: parseFloat(ohlc.close), t: 60, dir: pattern.dir, g: 0, val: valorEntrada };
                        enviarTelegram(gerarTextoBase(m, "ENTRADA CONFIRMADA"));
                    }
                }
            }
        }

        if (m.op.ativa) {
            m.op.t--;
            if (m.op.t <= 0) {
                let ganhou = (m.op.dir === "CALL" && parseFloat(m.preco) > m.op.pre) || (m.op.dir === "PUT" && parseFloat(m.preco) < m.op.pre);
                if (ganhou) {
                    if(m.op.g===0) stats.winDireto++; else if(m.op.g===1) stats.winG1++; else stats.winG2++;
                    fin.bancaAtual += m.op.val + (m.op.val * fin.payout);
                    enviarTelegram(gerarTextoBase(m, "GREEN ✅"));
                    m.op.ativa = false;
                } else if (m.op.g < 2) {
                    m.op.g++; m.op.val *= 2;
                    if(fin.bancaAtual >= m.op.val){
                        fin.bancaAtual -= m.op.val;
                        m.op.t = 60; m.op.pre = parseFloat(m.preco);
                        enviarTelegram(gerarTextoBase(m, `GALE ${m.op.g} ⚠️`));
                    } else {
                        stats.loss++; 
                        enviarTelegram(gerarTextoBase(m, "RED ❌ (SALDO)"));
                        m.op.ativa = false;
                    }
                } else {
                    stats.loss++; 
                    enviarTelegram(gerarTextoBase(m, "RED ❌"));
                    m.op.ativa = false;
                }
            }
        }
    });
    motores[cardId] = m;
}

app.post('/mudar', (req, res) => { 
    iniciarMotor(req.body.cardId, req.body.ativoId, req.body.nomeAtivo); 
    res.json({ success: true }); 
});

app.listen(PORT, () => console.log(`BRAIN PRO RODANDO NA PORTA ${PORT}`));
