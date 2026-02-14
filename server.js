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

// Variáveis globais
let fin = { bancaInicial: 5000, bancaAtual: 5000, payout: 0.95, percentual: 0.01 }; // Ajustado para 1% padrão
let stats = { winDireto: 0, winG1: 0, winG2: 0, loss: 0, totalAnalises: 0 };
let motores = {};

// --- ROTA CORRIGIDA PARA RECEBER DADOS DO PAINEL ---
app.post('/config-financeira', (req, res) => {
    const { banca, payout } = req.body;

    if (banca !== undefined) {
        fin.bancaInicial = Number(banca);
        fin.bancaAtual = Number(banca); // Reseta a banca atual para a nova banca inicial
        console.log(`Banca atualizada via painel: R$ ${fin.bancaInicial}`);
    }

    if (payout !== undefined) {
        // Converte de 95 para 0.95
        fin.payout = Number(payout) / 100;
    }

    res.json({ success: true, fin });
});

// --- STATUS PARA O PAINEL ---
app.get('/status', (req, res) => {
    const lucroReal = fin.bancaAtual - fin.bancaInicial;
    const totalWins = stats.winDireto + stats.winG1 + stats.winG2;
    const totalOps = totalWins + stats.loss;
    
    res.json({
        global: { 
            winDireto: stats.winDireto, 
            winGales: (stats.winG1 + stats.winG2), 
            loss: stats.loss, 
            banca: fin.bancaAtual.toFixed(2), 
            lucro: lucroReal.toFixed(2), 
            precisao: (totalOps > 0 ? (totalWins / totalOps * 100) : 0).toFixed(1) 
        },
        ativos: Object.keys(motores).map(id => ({
            cardId: id, 
            nome: motores[id].nome, 
            preco: motores[id].preco, 
            status: motores[id].op.ativa ? "OPERANDO" : "ANALISANDO",
            forca: motores[id].forca || 50
        }))
    });
});

// --- RESTANTE DA LÓGICA DO MOTOR (MANTIDA) ---
function obterHorarios() {
    const agora = new Date();
    const inicio = agora.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const fim = new Date(agora.getTime() + 60000).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    return { inicio, fim };
}

function gerarTextoBase(m, status, padraoNome = "", direcao = "") {
    const h = obterHorarios();
    const winTotal = stats.winDireto + stats.winG1 + stats.winG2;
    return `🚀 *BRAIN PRO: ${status}*\n\n` +
           `📊 Ativo: ${m.nome}\n` +
           `🎯 Padrão: ${padraoNome || m.op.est}\n` +
           `📈 Direção: ${direcao || m.op.dir}\n\n` +
           `⏰ Início: ${h.inicio}\n` +
           `🏁 Fim: ${h.fim}\n\n` +
           `🏆 Placar: ${winTotal}W | ${stats.loss}L\n` +
           `💰 Banca: R$ ${fin.bancaAtual.toFixed(2)}`;
}

function enviarTelegram(msg) {
    let payload = { chat_id: TG_CHAT_ID, text: msg, parse_mode: "Markdown", 
    reply_markup: { inline_keyboard: [[{ text: "📲 PREPARAR NA CORRETORA", url: LINK_CORRETORA }]] }};
    fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }).catch(e => console.log("Erro TG:", e.message));
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

function iniciarMotor(cardId, ativoId, nomeAtivo) {
    if (motores[cardId]?.ws) motores[cardId].ws.terminate();
    if (ativoId === "OFF") return;

    let m = {
        nome: nomeAtivo, alertado: false,
        ws: new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089'),
        preco: "0.0000", history: [],
        op: { ativa: false, est: "", pre: 0, t: 0, dir: "", g: 0, val: 0 }
    };

    m.ws.on('open', () => {
        m.ws.send(JSON.stringify({ ticks_history: ativoId, end: "latest", count: 60, style: "candles", granularity: 60, subscribe: 1 }));
    });

    m.ws.on('message', (data) => {
        const res = JSON.parse(data.toString());
        if (res.candles) m.history = res.candles;
        if (res.ohlc) {
            const ohlc = res.ohlc;
            m.preco = parseFloat(ohlc.close).toFixed(5);
            const s = new Date().getSeconds();

            if (s >= 50 && s <= 55 && !m.op.ativa && !m.alertado) {
                const pattern = analyzeCandlePatterns([...m.history, { open: ohlc.open, high: ohlc.high, low: ohlc.low, close: ohlc.close }]);
                if (pattern) {
                    enviarTelegram(`⚠️ *ALERTA DE POSSÍVEL ENTRADA*\n\n📊 Ativo: ${m.nome}\n🎯 Padrão: ${pattern.name}\n🕒 Prepare-se!`);
                    m.alertado = true;
                }
            }

            if (s === 0 && !m.op.ativa) {
                m.alertado = false;
                const pattern = analyzeCandlePatterns(m.history);
                if (pattern) {
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
                let ganhou = (m.op.dir === "CALL" && m.preco > m.op.pre) || (m.op.dir === "PUT" && m.preco < m.op.pre);
                if (ganhou) {
                    if(m.op.g===0) stats.winDireto++; else if(m.op.g===1) stats.winG1++; else stats.winG2++;
                    fin.bancaAtual += m.op.val + (m.op.val * fin.payout);
                    enviarTelegram(gerarTextoBase(m, "GREEN ✅"));
                    m.op.ativa = false;
                } else if (m.op.g < 2) {
                    m.op.g++; m.op.val *= 2;
                    if(fin.bancaAtual >= m.op.val){
                        fin.bancaAtual -= m.op.val;
                        m.op.t = 60; m.op.pre = m.preco;
                        enviarTelegram(gerarTextoBase(m, `GALE ${m.op.g} ⚠️`));
                    } else {
                        stats.loss++; enviarTelegram(gerarTextoBase(m, "RED ❌ (SALDO BAIXO)"));
                        m.op.ativa = false;
                    }
                } else {
                    stats.loss++; enviarTelegram(gerarTextoBase(m, "RED ❌"));
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

app.listen(PORT, () => console.log(`Servidor Brain Pro Alerta rodando na porta ${PORT}`));
