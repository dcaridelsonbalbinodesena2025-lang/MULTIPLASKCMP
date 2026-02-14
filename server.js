const WebSocket = require('ws');
const fetch = require('node-fetch');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000; 

const TG_TOKEN = "8427077212:AAEiL_3_D_-fukuaR95V3FqoYYyHvdCHmEI"; 
const TG_CHAT_ID = "-1003355965894"; 
const LINK_CORRETORA = "https://track.deriv.com/_S_W1N_"; 

let fin = { bancaInicial: 5000, bancaAtual: 5000, payout: 0.95 };
let stats = { winDireto: 0, winG1: 0, winG2: 0, loss: 0, totalAnalises: 0 };
let motores = {};

// --- AUXILIARES ---
function obterHorarios() {
    const agora = new Date();
    const entrada = agora.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const proximaVela = new Date(agora.getTime() + (60 - agora.getSeconds()) * 1000);
    return { 
        atual: entrada, 
        entrada: proximaVela.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
        fim: new Date(proximaVela.getTime() + 60000).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' }) 
    };
}

function getEMA(list, period = 20) {
    if (list.length < period) return 0;
    const k = 2 / (period + 1);
    let ema = list[0].close;
    for (let i = 1; i < list.length; i++) { ema = (list[i].close * k) + (ema * (1 - k)); }
    return ema;
}

function gerarMsg(m, status) {
    const h = obterHorarios();
    const winT = stats.winDireto + stats.winG1 + stats.winG2;
    return `🚀 *BRAIN PRO: ${status}*\n\n📊 Ativo: ${m.nome}\n🎯 Padrão: ${m.op.est}\n📈 Direção: ${m.op.dir}\n\n⏰ Início: ${h.atual}\n🏁 Fim: ${h.fim}\n\n🏆 Placar: ${winT}W | ${stats.loss}L\n💰 Banca: R$ ${fin.bancaAtual.toFixed(2)}`;
}

function enviarTelegram(msg) {
    let payload = { chat_id: TG_CHAT_ID, text: msg, parse_mode: "Markdown", 
    reply_markup: { inline_keyboard: [[{ text: "📲 ACESSAR CORRETORA", url: LINK_CORRETORA }]] }};
    fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).catch(e => {});
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
    let m = { nome: nomeAtivo, alertado: false, history: [], historyM5: [], op: { ativa: false, est: "", pre: 0, t: 0, dir: "", g: 0, val: 0 }, ws: new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089') };

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
            m.preco = parseFloat(ohlc.close);
            const s = new Date().getSeconds();
            const uM5 = m.historyM5[m.historyM5.length - 1];
            const tendM5 = uM5 ? (uM5.close >= uM5.open ? "CALL" : "PUT") : null;
            const ema20 = getEMA(m.history, 20);

            if (s >= 50 && s <= 55 && !m.op.ativa && !m.alertado) {
                const pattern = analyzeCandlePatterns([...m.history, { open: ohlc.open, close: ohlc.close, high: ohlc.high, low: ohlc.low }]);
                const emaOk = pattern ? (pattern.dir === "CALL" ? ohlc.close > ema20 : ohlc.close < ema20) : false;
                if (pattern && pattern.dir === tendM5 && emaOk) {
                    const h = obterHorarios();
                    enviarTelegram(`🔔 *ALERTA BRAIN PRO*\n\n📊 Ativo: ${m.nome}\n🎯 Padrão: ${pattern.name}\n📈 Direção: ${pattern.dir}\n🔍 M5 + EMA 20: ✅\n\n⏰ *ENTRADA ÀS:* ${h.entrada}`);
                    m.alertado = true;
                }
            }

            if (s === 0 && !m.op.ativa) {
                m.alertado = false;
                const pattern = analyzeCandlePatterns(m.history);
                const emaOk = pattern ? (pattern.dir === "CALL" ? m.history[m.history.length-1].close > ema20 : m.history[m.history.length-1].close < ema20) : false;
                if (pattern && pattern.dir === tendM5 && emaOk) {
                    m.op = { ativa: true, est: pattern.name, pre: m.preco, t: 60, dir: pattern.dir, g: 0, val: fin.bancaAtual * 0.01 };
                    enviarTelegram(gerarMsg(m, "ENTRADA CONFIRMADA"));
                }
            }
        }

        if (m.op.ativa) {
            m.op.t--;
            if (m.op.t <= 0) {
                let ganhou = (m.op.dir === "CALL" && m.preco > m.op.pre) || (m.op.dir === "PUT" && m.preco < m.op.pre);
                if (ganhou) {
                    if(m.op.g===0) stats.winDireto++; else if(m.op.g===1) stats.winG1++; else stats.winG2++;
                    fin.bancaAtual += (m.op.val * fin.payout);
                    enviarTelegram(gerarMsg(m, "GREEN ✅"));
                    m.op.ativa = false;
                } else if (m.op.g < 2) {
                    m.op.g++; m.op.val *= 2; m.op.t = 60; m.op.pre = m.preco;
                    enviarTelegram(gerarMsg(m, `GALE ${m.op.g} ⚠️`));
                } else {
                    stats.loss++;
                    enviarTelegram(gerarMsg(m, "RED ❌"));
                    m.op.ativa = false;
                }
            }
        }
    });
    motores[cardId] = m;
}

app.post('/mudar', (req, res) => { iniciarMotor(req.body.cardId, req.body.ativoId, req.body.nomeAtivo); res.json({ success: true }); });
app.listen(PORT, () => console.log(`BRAIN PRO RODANDO - M5 + EMA 20`));
