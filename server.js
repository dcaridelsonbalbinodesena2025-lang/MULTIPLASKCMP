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
let stats = { winDireto: 0, winG1: 0, winG2: 0, loss: 0 };
let motores = {};

// --- CONTROLES DINÂMICOS (Via Painel) ---
const OPCOES_EMA = [10, 20, 50, 100, 200, 300]; 
const OPCOES_TF = [60, 300, 900, 1800, 3600]; // Segundos (60=M1, 300=M5, 900=M15...)
let emaConfig = 20;  // EMA Período
let tfConfig = 300;  // TF de Análise Macro (M5 por padrão)

// --- FUNÇÕES TÉCNICAS K.C.M ULTIMATE ---
function getEMA(list, period) {
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

// Analisador de Padrões com Filtro de S/R e Volume (Lógica Ultimate)
function analyzeUltimatePatterns(list) {
    if(list.length < 20) return null;
    
    const last = list[list.length - 1];
    const prev = list[list.length - 2];
    const body = Math.abs(last.close - last.open);
    const upperWick = last.high - Math.max(last.open, last.close);
    const lowerWick = Math.min(last.open, last.close) - last.low;
    
    // Filtro de Volume/Volatilidade (Média das últimas 10 velas)
    const volAvg = list.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10;
    const volCheck = (last.high - last.low) >= (volAvg * 0.7);

    // Identificação de Suporte e Resistência simplificada (Últimos 50 candles)
    const recent = list.slice(-50);
    const resistances = recent.map(c => c.high).sort((a,b) => b-a).slice(0, 3);
    const supports = recent.map(c => c.low).sort((a,b) => a-b).slice(0, 3);
    
    const margemSR = (last.high - last.low) * 0.3;
    const noSuporte = supports.some(sup => Math.abs(last.low - sup) <= margemSR);
    const naResistencia = resistances.some(res => Math.abs(last.high - res) <= margemSR);

    if (!volCheck) return null;

    // Gatilhos
    if (lowerWick > body * 2 && noSuporte) return { name: "MARTELO VIP", dir: "CALL" };
    if (upperWick > body * 2 && naResistencia) return { name: "ESTRELA VIP", dir: "PUT" };
    
    // Engolfos com Filtro de Região
    if (last.close > last.open && prev.open > prev.close && last.close > prev.open && noSuporte) 
        return { name: "🔥 ENGOLFO VIP", dir: "CALL" };
    
    if (last.open > last.close && prev.close > prev.open && last.close < prev.open && naResistencia) 
        return { name: "🔥 ENGOLFO VIP", dir: "PUT" };

    return null;
}

// --- ROTAS DO PAINEL ---
app.post('/alternar-ema', (req, res) => {
    let idx = OPCOES_EMA.indexOf(emaConfig);
    emaConfig = OPCOES_EMA[(idx + 1) % OPCOES_EMA.length];
    res.json({ novaEma: emaConfig });
});

app.post('/alternar-tf', (req, res) => {
    let idx = OPCOES_TF.indexOf(tfConfig);
    tfConfig = OPCOES_TF[(idx + 1) % OPCOES_TF.length];
    // Reinicia motores para aplicar novo TF de análise
    Object.keys(motores).forEach(id => iniciarMotor(id, motores[id].ativoId, motores[id].nome));
    res.json({ novoTf: tfConfig });
});

// --- MOTOR DE OPERAÇÕES ---
function iniciarMotor(cardId, ativoId, nomeAtivo) {
    if (motores[cardId]?.ws) motores[cardId].ws.terminate();
    if (ativoId === "OFF") return;

    let m = {
        nome: nomeAtivo, ativoId: ativoId, alertado: false, history: [], historyMacro: [],
        ws: new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089'),
        preco: "0.0000", op: { ativa: false, est: "", pre: 0, t: 0, dir: "", g: 0, val: 0 }
    };

    m.ws.on('open', () => {
        // M1 para entradas
        m.ws.send(JSON.stringify({ ticks_history: ativoId, end: "latest", count: 100, style: "candles", granularity: 60, subscribe: 1 }));
        // TF Macro definido pelo usuário no painel
        m.ws.send(JSON.stringify({ ticks_history: ativoId, end: "latest", count: 50, style: "candles", granularity: tfConfig, subscribe: 1, req_id: "macro" }));
    });

    m.ws.on('message', (data) => {
        const res = JSON.parse(data.toString());
        if (res.candles && !res.req_id) m.history = res.candles;
        if (res.candles && res.req_id === "macro") m.historyMacro = res.candles;

        if (res.ohlc) {
            const ohlc = res.ohlc;
            if(ohlc.granularity === tfConfig) { 
                const lastMacro = m.historyMacro[m.historyMacro.length - 1];
                if(lastMacro) { lastMacro.close = ohlc.close; lastMacro.open = ohlc.open; }
                return; 
            }

            m.preco = parseFloat(ohlc.close).toFixed(5);
            const s = new Date().getSeconds();

            // Filtro de Tendência Macro (EMA do Painel + Cor da Vela Macro)
            const emaValue = getEMA(m.history, emaConfig);
            const uMacro = m.historyMacro[m.historyMacro.length - 1];
            const tendMacro = uMacro ? (uMacro.close >= uMacro.open ? "CALL" : "PUT") : null;

            // ALERTA (50s)
            if (s >= 50 && s <= 55 && !m.op.ativa && !m.alertado) {
                const pattern = analyzeUltimatePatterns([...m.history, { open: ohlc.open, close: ohlc.close, high: ohlc.high, low: ohlc.low }]);
                
                const emaOk = (pattern?.dir === "CALL" ? ohlc.close > emaValue : ohlc.close < emaValue);
                const macroOk = (pattern?.dir === tendMacro);

                if (pattern && emaOk && macroOk) {
                    enviarTelegram(`⚠️ *ALERTA K.C.M ULTIMATE*\n\n📊 Ativo: ${m.nome}\n🎯 Padrão: ${pattern.name}\n📈 Filtro: EMA${emaConfig} + TF Macro ✅`);
                    m.alertado = true;
                }
            }

            // ENTRADA (0s)
            if (s === 0 && !m.op.ativa) {
                m.alertado = false;
                const pattern = analyzeUltimatePatterns(m.history);
                const emaOk = (pattern?.dir === "CALL" ? m.history[m.history.length-1].close > emaValue : m.history[m.history.length-1].close < emaValue);
                const macroOk = (pattern?.dir === tendMacro);

                if (pattern && emaOk && macroOk) {
                    let valorEntrada = fin.bancaAtual * fin.percentual;
                    fin.bancaAtual -= valorEntrada;
                    m.op = { ativa: true, est: pattern.name, pre: parseFloat(ohlc.close), t: 60, dir: pattern.dir, g: 0, val: valorEntrada };
                    const h = obterHorarios();
                    enviarTelegram(`🚀 *ENTRADA CONFIRMADA*\n\n👉Clique agora!\n📊 Ativo: ${m.nome}\n📈 Direção: ${m.op.dir}\n💰 Banca: R$ ${fin.bancaAtual.toFixed(2)}\n⏰ Início: ${h.inicio} | Fim: ${h.fim}`);
                }
            }
        }

        // Lógica de Resultado e Aborto de Gale (Igual ao Ultimate)
        if (m.op.ativa) {
            m.op.t--;
            if (m.op.t <= 0) {
                let ganhou = (m.op.dir === "CALL" && parseFloat(m.preco) > m.op.pre) || (m.op.dir === "PUT" && parseFloat(m.preco) < m.op.pre);
                
                if (ganhou) {
                    if(m.op.g===0) stats.winDireto++; else if(m.op.g===1) stats.winG1++; else stats.winG2++;
                    fin.bancaAtual += m.op.val + (m.op.val * fin.payout);
                    enviarTelegram(`✅ *WIN NO ${m.nome}*\n💰 Banca: R$ ${fin.bancaAtual.toFixed(2)}`);
                    m.op.ativa = false;
                } else if (m.op.g < 2) {
                    // Verificação de Aborto antes de entrar no Gale
                    const emaV = getEMA(m.history, emaConfig);
                    const rompeuContra = (m.op.dir === "CALL" && parseFloat(m.preco) < emaV) || (m.op.dir === "PUT" && parseFloat(m.preco) > emaV);

                    if (rompeuContra) {
                        stats.loss++;
                        enviarTelegram(`🛡️ *GALE ABORTADO*\n⚠️ Rompimento detectado contra a tendência. Preservando banca.`);
                        m.op.ativa = false;
                    } else {
                        m.op.g++; 
                        let novoValorGale = m.op.val * 2;
                        fin.bancaAtual -= novoValorGale;
                        m.op.val = novoValorGale;
                        m.op.t = 60; m.op.pre = parseFloat(m.preco);
                        enviarTelegram(`⚠️ *ENTRANDO EM GALE ${m.op.g}*\n👉Clique agora!`);
                    }
                } else {
                    stats.loss++; 
                    enviarTelegram(`❌ *LOSS NO ${m.nome}*`);
                    m.op.ativa = false;
                }
            }
        }
    });
    motores[cardId] = m;
}

function enviarTelegram(msg) {
    let payload = { chat_id: TG_CHAT_ID, text: msg, parse_mode: "Markdown", 
    reply_markup: { inline_keyboard: [[{ text: "📲 PREPARAR NA CORRETORA", url: LINK_CORRETORA }]] }};
    fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }).catch(e => {});
}

app.post('/mudar', (req, res) => { 
    iniciarMotor(req.body.cardId, req.body.ativoId, req.body.nomeAtivo); 
    res.json({ success: true }); 
});

app.listen(PORT, () => console.log(`K.C.M ULTIMATE UNIFICADO RODANDO NA PORTA ${PORT}`));
