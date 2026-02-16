const WebSocket = require('ws');
const fetch = require('node-fetch');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000; 

// --- CONFIGURAÇÕES (Verifique se o Token e ChatID estão corretos) ---
const TG_TOKEN = "8427077212:AAEiL_3_D_-fukuaR95V3FqoYYyHvdCHmEI"; 
const TG_CHAT_ID = "-1003355965894"; 
const LINK_CORRETORA = "https://track.deriv.com/_S_W1N_"; 

// AJUSTE: Banca inicial não pode ser 0
let fin = { bancaInicial: 1000, bancaAtual: 1000, payout: 0.85, percentual: 0.01 }; 
let stats = { winDireto: 0, winG1: 0, winG2: 0, loss: 0 };
let motores = {};

let emaConfig = 20;  
let tfConfig = 300;  

const OPCOES_EMA = [10, 20, 50, 100, 200, 300]; 
const OPCOES_TF = [60, 300, 900, 1800, 3600];

// --- FUNÇÕES TÉCNICAS ---
function getEMA(list, period) {
    if (!list || list.length < period) return 0;
    const k = 2 / (period + 1);
    let ema = parseFloat(list[0].close);
    for (let i = 1; i < list.length; i++) { 
        ema = (parseFloat(list[i].close) * k) + (ema * (1 - k)); 
    }
    return ema;
}

function analyzeUltimatePatterns(list) {
    if(!list || list.length < 20) return null;
    
    const last = list[list.length - 1];
    const prev = list[list.length - 2];
    const body = Math.abs(last.close - last.open);
    const upperWick = last.high - Math.max(last.open, last.close);
    const lowerWick = Math.min(last.open, last.close) - last.low;
    
    // Filtro de Volume (70% da média)
    const volAvg = list.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10;
    const volCheck = (last.high - last.low) >= (volAvg * 0.7);

    // Suporte e Resistência (Simplificado para Backend)
    const recent = list.slice(-50);
    const resistances = recent.map(c => c.high).sort((a,b) => b-a).slice(0, 3);
    const supports = recent.map(c => c.low).sort((a,b) => a-b).slice(0, 3);
    
    const margemSR = (last.high - last.low) * 0.3;
    const noSuporte = supports.some(sup => Math.abs(last.low - sup) <= margemSR);
    const naResistencia = resistances.some(res => Math.abs(last.high - res) <= margemSR);

    if (!volCheck) return null;

    // Engolfo de Baixa + Resistência
    if (last.open > last.close && prev.close > prev.open && last.close < prev.open && naResistencia) 
        return { name: "🔥 ENGOLFO DE BAIXA VIP", dir: "PUT" };
    
    // Engolfo de Alta + Suporte
    if (last.close > last.open && prev.open > prev.close && last.close > prev.open && noSuporte) 
        return { name: "🔥 ENGOLFO DE ALTA VIP", dir: "CALL" };

    return null;
}

// --- MOTOR DE OPERAÇÕES ---
function iniciarMotor(cardId, ativoId, nomeAtivo) {
    if (motores[cardId]?.ws) motores[cardId].ws.terminate();
    
    console.log(`> Iniciando monitoramento: ${nomeAtivo} (${ativoId})`);

    let m = {
        nome: nomeAtivo, ativoId: ativoId, alertado: false, history: [], historyMacro: [],
        ws: new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089'),
        preco: "0.0000", op: { ativa: false, est: "", pre: 0, t: 0, dir: "", g: 0, val: 0 }
    };

    m.ws.on('open', () => {
        m.ws.send(JSON.stringify({ ticks_history: ativoId, end: "latest", count: 100, style: "candles", granularity: 60, subscribe: 1 }));
        m.ws.send(JSON.stringify({ ticks_history: ativoId, end: "latest", count: 50, style: "candles", granularity: tfConfig, subscribe: 1, req_id: "macro" }));
    });

    m.ws.on('message', (data) => {
        const res = JSON.parse(data.toString());
        
        if (res.candles && !res.req_id) m.history = res.candles;
        if (res.candles && res.req_id === "macro") m.historyMacro = res.candles;

        if (res.ohlc) {
            const ohlc = res.ohlc;
            if (ohlc.granularity === tfConfig) return; // Ignora atualização do macro aqui

            m.preco = parseFloat(ohlc.close);
            const s = new Date().getSeconds();

            const emaValue = getEMA(m.history, emaConfig);
            const uMacro = m.historyMacro[m.historyMacro.length - 1];
            const tendMacro = uMacro ? (uMacro.close >= uMacro.open ? "CALL" : "PUT") : null;

            // Lógica de Entrada no Segundo 0
            if (s === 0 && !m.op.ativa) {
                const pattern = analyzeUltimatePatterns(m.history);
                if (pattern) {
                    const emaOk = (pattern.dir === "CALL" ? m.preco > emaValue : m.preco < emaValue);
                    const macroOk = (pattern.dir === tendMacro);

                    if (emaOk && macroOk) {
                        let valorEntrada = fin.bancaAtual * fin.percentual;
                        m.op = { ativa: true, est: pattern.name, pre: m.preco, t: 60, dir: pattern.dir, g: 0, val: valorEntrada };
                        fin.bancaAtual -= valorEntrada;
                        enviarTelegram(`🚀 *ENTRADA CONFIRMADA*\n📊 Ativo: ${m.nome}\n📈 Direção: ${pattern.dir}\n🎯 Estratégia: ${pattern.name}`);
                    }
                }
            }
        }
        
        // Lógica de resultado omitida para brevidade (mantém a que você enviou)
    });

    motores[cardId] = m;
}

// --- ROTAS PARA CONTROLE (Use o Postman ou seu HTML para chamar) ---

// 1. Iniciar um ativo (Ex: Volatility 100)
app.post('/mudar', (req, res) => {
    const { cardId, ativoId, nomeAtivo } = req.body;
    iniciarMotor(cardId, ativoId, nomeAtivo);
    res.json({ msg: `Monitorando ${nomeAtivo}` });
});

// 2. Mudar EMA e TF
app.post('/config', (req, res) => {
    if(req.body.ema) emaConfig = req.body.ema;
    if(req.body.tf) tfConfig = req.body.tf;
    res.json({ ema_atual: emaConfig, tf_macro_atual: tfConfig });
});

function enviarTelegram(msg) {
    fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TG_CHAT_ID, text: msg, parse_mode: "Markdown" })
    }).catch(e => console.log("Erro Telegram"));
}

app.listen(PORT, () => console.log(`ROBÔ ATIVO NA PORTA ${PORT}`));
