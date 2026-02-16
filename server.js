const WebSocket = require('ws');
const fetch = require('node-fetch');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000; 

// --- DADOS DO BOT ---
const TG_TOKEN = "8427077212:AAEiL_3_D_-fukuaR95V3FqoYYyHvdCHmEI"; 
const TG_CHAT_ID = "-1003355965894"; 
const LINK_CORRETORA = "https://track.deriv.com/_S_W1N_"; 

let fin = { bancaInicial: 5000, bancaAtual: 5000, payout: 0.95 };
let stats = { winDireto: 0, winG1: 0, winG2: 0, loss: 0 };
let motores = {};

// --- HORA E EMA ---
function obterHorarios() {
    const agora = new Date();
    const proximaVela = new Date(agora.getTime() + (60 - agora.getSeconds()) * 1000);
    return { 
        atual: agora.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
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

// --- ENDPOINTS (AQUI ESTÁ A SOLUÇÃO) ---

// 1. Faz o preço se mexer e o Placar atualizar
app.get('/status', (req, res) => {
    res.json({
        global: { 
            winDireto: stats.winDireto, winGales: (stats.winG1 + stats.winG2), loss: stats.loss, 
            banca: fin.bancaAtual.toFixed(2), lucro: (fin.bancaAtual - fin.bancaInicial).toFixed(2),
            precisao: (stats.winDireto + stats.winG1 + stats.winG2 + stats.loss) > 0 ? (((stats.winDireto+stats.winG1+stats.winG2) / (stats.winDireto+stats.winG1+stats.winG2+stats.loss)) * 100).toFixed(1) : "0.0"
        },
        ativos: Object.keys(motores).map(id => ({ 
            cardId: id, nome: motores[id].nome, preco: motores[id].preco, 
            status: motores[id].op.ativa ? "EM OPERAÇÃO" : "BRAIN PRO: ANALISANDO" 
        }))
    });
});

// 2. FAZ O BOTÃO SALVAR FUNCIONAR
app.post('/config-financeira', (req, res) => {
    const { banca, payout } = req.body;
    if (banca !== undefined) {
        fin.bancaInicial = parseFloat(banca);
        fin.bancaAtual = parseFloat(banca); // Aqui ele atualiza a banca atual para o novo valor
    }
    if (payout !== undefined) fin.payout = parseFloat(payout) / 100;
    
    console.log(`💰 Configuração Financeira Atualizada: Banca R$ ${fin.bancaAtual}`);
    res.json({ success: true });
});

// 3. Muda o ativo do monitor
app.post('/mudar', (req, res) => { 
    iniciarMotor(req.body.cardId, req.body.ativoId, req.body.nomeAtivo); 
    res.json({ success: true }); 
});

// --- MOTOR DE ANÁLISE ---
function iniciarMotor(cardId, ativoId, nomeAtivo) {
    if (motores[cardId]?.ws) motores[cardId].ws.terminate();
    
    let m = { 
        nome: nomeAtivo, alertado: false, history: [], historyM5: [], preco: "0.0000",
        op: { ativa: false, est: "", pre: 0, t: 0, dir: "", g: 0, val: 0 }, 
        ws: new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089') 
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

            // Alerta e Entrada (com M5 + EMA)
            if (s >= 50 && s <= 55 && !m.op.ativa) {
                // ... lógica de análise ...
            }
        }
    });
    motores[cardId] = m;
}

app.listen(PORT, () => console.log(`BRAIN PRO ONLINE - BOTÃO SALVAR OK`));
