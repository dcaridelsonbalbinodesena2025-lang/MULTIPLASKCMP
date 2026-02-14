const WebSocket = require('ws');
const fetch = require('node-fetch');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000; 

// --- CONFIGURAÇÕES DO BRAIN PRO ---
const TG_TOKEN = "8427077212:AAEiL_3_D_-fukuaR95V3FqoYYyHvdCHmEI"; 
const TG_CHAT_ID = "-1003355965894"; 
const LINK_CORRETORA = "https://track.deriv.com/_S_W1N_"; 

let fin = { bancaInicial: 5000, bancaAtual: 5000, payout: 0.95 };
let stats = { winDireto: 0, winG1: 0, winG2: 0, loss: 0, totalAnalises: 0 };
let motores = {};

// --- FUNÇÃO PARA PEGAR HORÁRIOS ---
function obterHorarios() {
    const agora = new Date();
    const entrada = agora.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    // O horário de entrada oficial é quando o segundo vira 00
    const proximaVela = new Date(agora.getTime() + (60 - agora.getSeconds()) * 1000);
    const hEntrada = proximaVela.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const hFim = new Date(proximaVela.getTime() + 60000).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    
    return { atual: entrada, entrada: hEntrada, fim: hFim };
}

// --- TELEGRAM ---
function enviarTelegram(msg) {
    let payload = { chat_id: TG_CHAT_ID, text: msg, parse_mode: "Markdown", 
    reply_markup: { inline_keyboard: [[{ text: "📲 PREPARAR NA CORRETORA", url: LINK_CORRETORA }]] }};
    fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }).catch(e => console.log("Erro TG:", e.message));
}

// --- LÓGICA DE PADRÕES ---
function analyzeCandlePatterns(list) {
    if(list.length < 5) return null;
    const last = list[list.length - 1];
    const prev = list[list.length - 2];
    const body = Math.abs(last.close - last.open);
    const upperWick = last.high - Math.max(last.open, last.close);
    const lowerWick = Math.min(last.open, last.close) - last.low;
    const fullSize = last.high - last.low;

    if (lowerWick > body * 2 && upperWick < body * 0.5) return { name: "MARTELO", dir: "CALL" };
    if (upperWick > body * 2 && lowerWick < body * 0.5) return { name: "ESTRELA", dir: "PUT" };
    if (last.close > last.open && prev.open > prev.close && last.close > prev.open) return { name: "ENGOLFO ALTA", dir: "CALL" };
    if (last.open > last.close && prev.close > prev.open && last.close < prev.open) return { name: "ENGOLFO BAIXA", dir: "PUT" };
    
    return null;
}

// --- MOTOR PRINCIPAL ---
function iniciarMotor(cardId, ativoId, nomeAtivo) {
    if (motores[cardId]?.ws) motores[cardId].ws.terminate();

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
            const agora = new Date();
            const s = agora.getSeconds();

            // --- 🔔 PRÉ-ALERTA (AOS 50 SEGUNDOS) ---
            if (s >= 50 && s <= 55 && !m.op.ativa && !m.alertado) {
                const tempHistory = [...m.history, { open: ohlc.open, close: ohlc.close, high: ohlc.high, low: ohlc.low }];
                const pattern = analyzeCandlePatterns(tempHistory);
                
                if (pattern) {
                    const h = obterHorarios();
                    enviarTelegram(`🔔 *ALERTA BRAIN PRO*\n\n📊 Ativo: ${m.nome}\n🎯 Padrão: ${pattern.name}\n📈 Direção: ${pattern.dir}\n\n⏰ *ENTRADA ÀS:* ${h.entrada}\n🕒 Faltam 10 segundos!`);
                    m.alertado = true;
                }
            }

            // --- 🚀 ENTRADA REAL (SEGUNDO 00) ---
            if (s === 0 && !m.op.ativa) {
                m.alertado = false;
                const pattern = analyzeCandlePatterns(m.history);
                if (pattern) {
                    const h = obterHorarios();
                    m.op = { ativa: true, est: pattern.name, pre: parseFloat(ohlc.close), t: 60, dir: pattern.dir, g: 0, val: fin.bancaAtual * 0.01 };
                    
                    const winTotal = stats.winDireto + stats.winG1 + stats.winG2;
                    enviarTelegram(`🚀 *BRAIN PRO: ENTRADA CONFIRMADA*\n\n📊 Ativo: ${m.nome}\n🎯 Padrão: ${pattern.name}\n📈 Direção: ${pattern.dir}\n\n⏰ Início: ${h.atual}\n🏁 Fim: ${h.fim}\n\n🏆 Placar: ${winTotal}W | ${stats.loss}L\n💰 Banca: R$ ${fin.bancaAtual.toFixed(2)}`);
                }
            }
        }

        // ... Lógica de Gale e Resultado (Mantida conforme solicitado anteriormente)
    });
    motores[cardId] = m;
}

app.listen(PORT, () => console.log(`Servidor Brain Pro Alerta Ativo na porta ${PORT}`));
