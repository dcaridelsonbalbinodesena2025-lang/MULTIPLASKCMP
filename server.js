const WebSocket = require('ws');
const fetch = require('node-fetch');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000; 

// --- CONFIGURAÇÕES DO BRAIN PRO INTEGRADO ---
const HORA_INICIO = 0;
const HORA_FIM = 23;    
const TG_TOKEN = "8427077212:AAEiL_3_D_-fukuaR95V3FqoYYyHvdCHmEI"; 
const TG_CHAT_ID = "-1003355965894"; 
const LINK_CORRETORA = "https://track.deriv.com/_S_W1N_"; 

let configEstrategias = { "BRAIN_PRO": true }; // Foco total na nova lógica
let fin = { bancaInicial: 5000, bancaAtual: 5000, payout: 0.95, perdaTotal: 0 };
let stats = { winDireto: 0, winG1: 0, winG2: 0, loss: 0, totalAnalises: 0 };
let rankingEstrategias = {}; // Será preenchido dinamicamente pelos nomes dos padrões

let motores = {};

// --- FUNÇÕES DE AUXÍLIO PARA MENSAGENS ---
function obterHorarios() {
    const agora = new Date();
    const inicio = agora.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const fim = new Date(agora.getTime() + 60000).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    return { inicio, fim };
}

function gerarTextoBase(m, status) {
    const h = obterHorarios();
    const winTotal = stats.winDireto + stats.winG1 + stats.winG2;
    return `🚀 *BRAIN PRO: ${status}*\n\n` +
           `📊 Ativo: ${m.nome}\n` +
           `🎯 Padrão: ${m.op.est}\n` +
           `📈 Direção: ${m.op.dir}\n\n` +
           `⏰ Início: ${h.inicio}\n` +
           `🏁 Fim: ${h.fim}\n\n` +
           `🏆 Placar: ${winTotal}W | ${stats.loss}L\n` +
           `💰 Banca: R$ ${fin.bancaAtual.toFixed(2)}`;
}

// --- FUNÇÕES DE APOIO (LÓGICA BRAIN PRO) ---
function getEMA(list, period = 20) {
    if (list.length < period) return 0;
    const k = 2 / (period + 1);
    let ema = list[0].close;
    for (let i = 1; i < list.length; i++) {
        ema = (list[i].close * k) + (ema * (1 - k));
    }
    return ema;
}

function analyzeCandlePatterns(list) {
    if(list.length < 5) return null;
    const last = list[list.length - 1];
    const prev = list[list.length - 2];
    const body = Math.abs(last.close - last.open);
    const upperWick = last.high - Math.max(last.open, last.close);
    const lowerWick = Math.min(last.open, last.close) - last.low;
    const fullSize = last.high - last.low;

    // LÓGICA DE PADRÕES DO BRAIN PRO
    if (lowerWick > body * 2 && upperWick < body * 0.5) return { name: "MARTELO", dir: "CALL" };
    if (upperWick > body * 2 && lowerWick < body * 0.5) return { name: "ESTRELA", dir: "PUT" };
    if (last.close > last.open && prev.open > prev.close && last.close > prev.open) return { name: "ENGOLFO ALTA", dir: "CALL" };
    if (last.open > last.close && prev.close > prev.open && last.close < prev.open) return { name: "ENGOLFO BAIXA", dir: "PUT" };
    if (body > fullSize * 0.8 && last.close > last.open) return { name: "FORÇA ALTA", dir: "CALL" };
    if (body > fullSize * 0.8 && last.close < last.open) return { name: "FORÇA BAIXA", dir: "PUT" };

    return null;
}

// --- TELEGRAM ---
function enviarTelegram(msg) {
    let payload = { chat_id: TG_CHAT_ID, text: msg, parse_mode: "Markdown", 
    reply_markup: { inline_keyboard: [[{ text: "📲 ACESSAR CORRETORA", url: LINK_CORRETORA }]] }};
    fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }).catch(e => console.log("Erro TG:", e.message));
}

// --- MOTOR PRINCIPAL ---
function iniciarMotor(cardId, ativoId, nomeAtivo) {
    if (motores[cardId]?.ws) motores[cardId].ws.terminate();
    if (ativoId === "OFF") return motores[cardId] = { nome: "OFF", status: "OFF", preco: "---" };

    let m = {
        nome: nomeAtivo, status: "ANALISANDO PRICE ACTION",
        ws: new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089'),
        preco: "0.0000", history: [],
        op: { ativa: false, est: "", pre: 0, t: 0, dir: "", g: 0, val: 0 }
    };

    m.ws.on('open', () => {
        m.ws.send(JSON.stringify({ 
            ticks_history: ativoId, end: "latest", count: 60, 
            style: "candles", granularity: 60, subscribe: 1 
        }));
    });

    m.ws.on('message', (data) => {
        const res = JSON.parse(data.toString());
        
        if (res.candles) m.history = res.candles;

        if (res.ohlc) {
            const ohlc = res.ohlc;
            m.preco = parseFloat(ohlc.close).toFixed(5);
            const agora = new Date();
            const s = agora.getSeconds();
            
            if (s === 0 && !m.op.ativa) {
                const pattern = analyzeCandlePatterns(m.history);
                const ema20 = getEMA(m.history, 20);

                if (pattern) {
                    let trendOk = (pattern.dir === "CALL" && ohlc.close > ema20) || 
                                  (pattern.dir === "PUT" && ohlc.close < ema20);

                    if (trendOk) {
                        disparar(m, pattern.name, pattern.dir, fin.bancaAtual * 0.01, parseFloat(ohlc.close));
                        enviarTelegram(gerarTextoBase(m, "ENTRADA"));
                    }
                }
                m.history.push({ open: ohlc.open, high: ohlc.high, low: ohlc.low, close: ohlc.close });
                if (m.history.length > 60) m.history.shift();
            }
        }

        if (m.op.ativa) {
            m.op.t--;
            if (m.op.t <= 0) {
                let ganhou = (m.op.dir === "CALL" && m.preco > m.op.pre) || (m.op.dir === "PUT" && m.preco < m.op.pre);
                if (ganhou) {
                    if(m.op.g===0) stats.winDireto++; else if(m.op.g===1) stats.winG1++; else stats.winG2++;
                    fin.bancaAtual += (m.op.val * fin.payout);
                    enviarTelegram(gerarTextoBase(m, "GREEN ✅"));
                    m.op.ativa = false;
                    stats.totalAnalises++;
                } else if (m.op.g < 2) {
                    m.op.g++; m.op.val *= 2; m.op.t = 60; m.op.pre = m.preco;
                    enviarTelegram(gerarTextoBase(m, `GALE ${m.op.g}`));
                } else {
                    stats.loss++; stats.totalAnalises++;
                    enviarTelegram(gerarTextoBase(m, "RED ❌"));
                    m.op.ativa = false;
                }
            }
        }
    });
    motores[cardId] = m;
}

function disparar(m, est, dir, val, pre) {
    m.op = { ativa: true, est: est, pre: pre, t: 60, dir: dir, g: 0, val: val };
}

// ENDPOINTS PARA O SEU HTML
app.get('/status', (req, res) => {
    res.json({
        global: { 
            winDireto: stats.winDireto, winGales: (stats.winG1 + stats.winG2), loss: stats.loss, 
            precisao: stats.totalAnalises > 0 ? (((stats.winDireto+stats.winG1+stats.winG2) / stats.totalAnalises) * 100).toFixed(1) : "0.0",
            banca: fin.bancaAtual.toFixed(2), lucro: (fin.bancaAtual - fin.bancaInicial).toFixed(2) 
        },
        ativos: Object.keys(motores).map(id => ({ cardId: id, nome: motores[id].nome, preco: motores[id].preco, status: motores[id].op?.ativa ? "EM OPERAÇÃO" : "BRAIN PRO: ANALISANDO" }))
    });
});

app.post('/mudar', (req, res) => { iniciarMotor(req.body.cardId, req.body.ativoId, req.body.nomeAtivo); res.json({ success: true }); });
app.post('/config-financeira', (req, res) => {
    if (req.body.banca) { fin.bancaInicial = req.body.banca; fin.bancaAtual = req.body.banca; }
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`Servidor Multi-Estratégia BRAIN PRO na porta ${PORT}`));
