Server abaixo:


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

// --- ROTA DE CONFIGURAÇÃO (BOTÃO SALVAR) ---
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

    const avgPrice = list.slice(-5).reduce((acc, c) => acc + c.close, 0) / 5;
    const isSupport = last.close <= avgPrice;

    if (lowerWick > body * 2 && upperWick < body * 0.5 && isSupport) return { name: "MARTELO", dir: "CALL" };
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
        m.ws.send(JSON.stringify({ ticks_history: ativoId, end: "latest", count: 100, style: "candles", granularity: 60, subscribe: 1 }));
        
        // ===========================================================================
        // --- AQUI VOCÊ MUDA O PERÍODO DO JUIZ DE TENDÊNCIA (M5, M15, M1...) ---
        // granularity: 60 (M1), 300 (M5), 900 (M15), 3600 (H1)
        // ===========================================================================
        m.ws.send(JSON.stringify({ ticks_history: ativoId, end: "latest", count: 10, style: "candles", granularity: 300, subscribe: 1, req_id: "validaM5" }));
    });

    m.ws.on('message', (data) => {
        const res = JSON.parse(data.toString());
        if (res.candles && !res.req_id) m.history = res.candles;
        if (res.candles && res.req_id === "validaM5") m.historyM5 = res.candles;

        if (res.ohlc) {
            const ohlc = res.ohlc;
            
            // Sincroniza o fechamento da vela do juiz (M5)
            if(ohlc.granularity === 300) { 
                const lastM5 = m.historyM5[m.historyM5.length - 1];
                if(lastM5) { lastM5.close = ohlc.close; lastM5.open = ohlc.open; }
                return; 
            }

            m.preco = parseFloat(ohlc.close).toFixed(5);
            const s = new Date().getSeconds();

            // ===========================================================================
            // --- AQUI VOCÊ MUDA O PERÍODO DA EMA (10, 20, 50, 100, 200) ---
            // Exemplos: 10 (Rápida), 20 (Padrão), 100/200 (Tendência Forte)
            // ===========================================================================
            const PERIODO_EMA = 10; 
            const emaValue = getEMA(m.history, PERIODO_EMA);
            
            const uM5 = m.historyM5[m.historyM5.length - 1];
            const tendM5 = uM5 ? (uM5.close >= uM5.open ? "CALL" : "PUT") : null;
            // ===========================================================================

            // MENSAGEM: ALERTA (Com validação dos Juízes)
            if (s >= 50 && s <= 55 && !m.op.ativa && !m.alertado) {
                const pattern = analyzeCandlePatterns([...m.history, { open: ohlc.open, close: ohlc.close, high: ohlc.high, low: ohlc.low }]);
                
                // Validação: Padrão a favor da EMA e a favor da tendência M5
                const emaOk = pattern ? (pattern.dir === "CALL" ? ohlc.close > emaValue : ohlc.close < emaValue) : false;
                const m5Ok = pattern ? (pattern.dir === tendM5) : false;

                if (pattern && emaOk && m5Ok) {
                    const hPrevisao = new Date(new Date().getTime() + (60 - s) * 1000).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
                    enviarTelegram(`⚠️ *ALERTA BRAIN PRO*\n\n📊 Ativo: ${m.nome}\n🎯 Padrão: ${pattern.name}\n📈 Filtro: EMA${PERIODO_EMA}+M5 ✅\n🕓 Possível entrada: ${hPrevisao}`);
                    m.alertado = true;
                }
            }

            // MENSAGEM: ENTRADA (Validada pelos Juízes)
            if (s === 0 && !m.op.ativa) {
                m.alertado = false;
                const pattern = analyzeCandlePatterns(m.history);
                
                const emaOk = pattern ? (m.history[m.history.length-1].close > emaValue ? "CALL" : "PUT") === pattern.dir : false;
                const m5Ok = pattern ? (pattern.dir === tendM5) : false;

                if (pattern && emaOk && m5Ok) {
                    let valorEntrada = fin.bancaAtual * fin.percentual;
                    if(valorEntrada <= 0) valorEntrada = 2.00; 

                    fin.bancaAtual -= valorEntrada;
                    m.op = { ativa: true, est: pattern.name, pre: parseFloat(ohlc.close), t: 60, dir: pattern.dir, g: 0, val: valorEntrada };
                    const h = obterHorarios();
                    enviarTelegram(`🚀 *ENTRADA CONFIRMADA*\n\n👉Clique agora!\n📊 Ativo: ${m.nome}\n🎯 Padrão: ${m.op.est}\n📈 Direção: ${m.op.dir}\n💰 Entrada: R$ ${valorEntrada.toFixed(2)}\n💰 Banca atual: R$ ${fin.bancaAtual.toFixed(2)}\n⏰ Inicio: ${h.inicio}\n🏁 Fim: ${h.fim}`);
                }
            }
        }

        if (m.op.ativa) {
            m.op.t--;
            if (m.op.t <= 0) {
                let ganhou = (m.op.dir === "CALL" && parseFloat(m.preco) > m.op.pre) || (m.op.dir === "PUT" && parseFloat(m.preco) < m.op.pre);
                const placarStr = `G: ${stats.winDireto + stats.winG1 + stats.winG2} : R: ${stats.loss}`;

                if (ganhou) {
                    if(m.op.g===0) stats.winDireto++; else if(m.op.g===1) stats.winG1++; else stats.winG2++;
                    fin.bancaAtual += m.op.val + (m.op.val * fin.payout);
                    enviarTelegram(`✅ *STATUS: GREEN*\n\n📊 Ativo: ${m.nome}\n🎯 Padrão: ${m.op.est}\n📈 Direção: ${m.op.dir}\n💰 Banca Atual: R$ ${fin.bancaAtual.toFixed(2)}\n🔥 PLACAR: ${placarStr}`);
                    m.op.ativa = false;
                } else if (m.op.g < 2) {
                    m.op.g++; 
                    let novoValorGale = m.op.val * 2;
                    fin.bancaAtual -= novoValorGale;
                    m.op.val = novoValorGale;
                    m.op.t = 60; m.op.pre = parseFloat(m.preco);
                    const h = obterHorarios();
                    enviarTelegram(`⚠️ *GALE ${m.op.g}*\n\n👉Clique agora!\n📊 Ativo: ${m.nome}\n🎯 Padrão: ${m.op.est}\n📈 Direção: ${m.op.dir}\n💰 Entrada: R$ ${m.op.val.toFixed(2)}\n💰 Banca atual: R$ ${fin.bancaAtual.toFixed(2)}\n⏰ Inicio: ${h.inicio}\n🏁 Fim: ${h.fim}`);
                } else {
                    stats.loss++; 
                    enviarTelegram(`❌ *STATUS: RED*\n\n📊 Ativo: ${m.nome}\n🎯 Padrão: ${m.op.est}\n📈 Direção: ${m.op.dir}\n💰 Banca Atual: R$ ${fin.bancaAtual.toFixed(2)}\n🔥 PLACAR: ${placarStr}`);
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




E o index.html abaixo:


<!DOCTYPE html>
<html lang="pt-br">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>KCM - BRAIN PRO CONTROL</title>
    <style>
        :root { 
            --neon-blue: #1e90ff; --neon-green: #00ff88; --neon-red: #ff3355; 
            --gale: #f0b90b; --bg-dark: #05070a; --royal-blue: #0047AB;
        }
        body { background: var(--bg-dark); color: white; font-family: 'Segoe UI', sans-serif; margin: 0; padding: 10px; display: flex; flex-direction: column; align-items: center; }
        .logo { font-size: 22px; font-weight: 900; color: #fff; margin: 10px 0; }
        .logo span { color: var(--neon-blue); font-style: italic; }
        
        .srv-status { font-size: 9px; padding: 4px 12px; border-radius: 20px; background: #000; border: 1px solid var(--neon-green); color: var(--neon-green); margin-bottom: 15px; text-transform: uppercase; }

        .painel-financeiro { background: #111418; border: 2px solid var(--neon-green); border-radius: 15px; width: 95%; max-width: 600px; padding: 15px; margin-bottom: 15px; }
        .fin-row { display: flex; gap: 10px; justify-content: space-between; margin-bottom: 15px; }
        .fin-input-group { flex: 1; }
        .fin-input-group label { font-size: 9px; color: #888; display: block; margin-bottom: 4px; }
        .fin-input { width: 90%; background: #000; border: 1px solid #333; color: #fff; padding: 8px; border-radius: 5px; font-weight: bold; }
        
        .display-stats { display: flex; justify-content: space-around; text-align: center; margin-top: 10px; }
        .display-stats div { flex: 1; }
        .display-stats span { font-size: 8px; color: #888; display: block; }
        .display-stats b { font-size: 14px; cursor: default; } /* cursor default para indicar que não é editável */

        .painel-central { background: #111418; border-radius: 15px; width: 95%; max-width: 600px; padding: 15px; border: 1px solid #222; }
        .grid-estrat { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 15px; }
        .estrat-card { background: #000; padding: 10px; border-radius: 10px; border: 1px solid #222; text-align: center; }
        .estrat-name { font-size: 9px; color: #888; margin-bottom: 5px; }
        .btn-toggle { background: var(--neon-green); color: #000; padding: 6px; font-size: 10px; font-weight: bold; border-radius: 5px; border: none; width: 100%; cursor: pointer; }
        .btn-off { background: var(--neon-red); color: #fff; }

        .btn-salvar-grande { background: var(--neon-green); color: #000; border: none; padding: 12px; border-radius: 8px; font-weight: 900; cursor: pointer; width: 100%; margin: 15px 0; font-size: 12px; }

        .barra-global { background: #05070a; border: 1px solid var(--royal-blue); border-radius: 10px; width: 100%; padding: 10px 0; display: flex; justify-content: space-around; margin-bottom: 20px; }
        .stat-item { text-align: center; }
        .stat-item span { font-size: 8px; color: #888; }
        .stat-item b { display: block; font-size: 14px; }

        .grid-monitores { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; width: 100%; max-width: 600px; }
        .card { background: #080a0d; border-radius: 15px; padding: 12px; border: 1px solid #1e2228; text-align: center; }
        .thermometer-wrap { width: 100%; height: 6px; background: #222; border-radius: 3px; margin: 10px 0; overflow: hidden; }
        .thermometer-fill { height: 100%; width: 50%; background: linear-gradient(90deg, #ff3355, #f0b90b, #00ff88); transition: 0.5s; }
        .status-box { background: #000; padding: 6px; border-radius: 5px; margin-bottom: 8px; font-size: 9px; color: var(--neon-blue); font-weight: bold; border: 1px solid #222; }
        .price { color: var(--gale); font-family: monospace; font-size: 11px; margin-bottom: 8px; }
        .select-ativo { background: #000; color: #fff; border: 1px solid #444; font-size: 10px; width: 100%; padding: 5px; border-radius: 4px; }
    </style>
</head>
<body>

    <div class="logo">K.C<span>📈</span>M BRAIN PRO-CONTROL</div>
    <div id="conexao" class="srv-status">BOT OPERACIONAL - PRICE ACTION ATIVO</div>

    <div class="painel-financeiro">
        <div class="fin-row">
            <div class="fin-input-group">
                <label>BANCA INICIAL (R$)</label>
                <input type="number" id="inpBanca" class="fin-input" value="5000" 
                    onfocus="estaEditando = true" 
                    onblur="estaEditando = false" 
                    oninput="document.getElementById('display-banca').innerText = 'R$ ' + parseFloat(this.value || 0).toFixed(2)">
            </div>
            <div class="fin-input-group">
                <label>PAYOUT (%)</label>
                <input type="number" id="inpPayout" class="fin-input" value="95" onfocus="estaEditando = true" onblur="estaEditando = false">
            </div>
        </div>
        <div class="display-stats">
            <div><span>BANCA ATUAL</span><b id="display-banca">R$ 5000.00</b></div>
            <div><span>LUCRO HOJE</span><b id="display-lucro" style="color:var(--neon-green)">R$ 0.00</b></div>
            <div><span>CRESCIMENTO</span><b id="display-crescimento" style="color:var(--neon-blue)">0%</b></div>
            <div><span>SIMULADOR</span><b id="display-simulador" style="color:var(--gale)">1%</b></div>
        </div>
    </div>

    <div class="painel-central">
        <div class="grid-estrat">
            <div class="estrat-card">
                <div class="estrat-name">MARTELO / ESTRELA</div>
                <button id="btn-REGRA 1" class="btn-toggle" onclick="toggleEstrat('REGRA 1')">ATIVO</button>
            </div>
            <div class="estrat-card">
                <div class="estrat-name">ENGOLFO DE FORÇA</div>
                <button id="btn-FLUXO SNIPER" class="btn-toggle" onclick="toggleEstrat('FLUXO SNIPER')">ATIVO</button>
            </div>
            <div class="estrat-card">
                <div class="estrat-name">FILTRO MÉDIA EMA 20</div>
                <button id="btn-ZIGZAG FRACTAL" class="btn-toggle" onclick="toggleEstrat('ZIGZAG FRACTAL')">ATIVO</button>
            </div>
            <div class="estrat-card">
                <div class="estrat-name">REJEIÇÃO DE PAVIO</div>
                <button id="btn-SNIPER (RETRAÇÃO)" class="btn-toggle" onclick="toggleEstrat('SNIPER (RETRAÇÃO)')">ATIVO</button>
            </div>
        </div>

        <button class="btn-salvar-grande" onclick="salvarTudo()">SALVAR BANCA/PAYOUT</button>

        <div class="barra-global">
            <div class="stat-item"><span>WINS DIRETO</span><b id="g-direto" style="color:var(--neon-green)">0</b></div>
            <div class="stat-item"><span>WINS GALES</span><b id="g-gales" style="color:var(--gale)">0</b></div>
            <div class="stat-item"><span>LOSS TOTAL</span><b id="g-loss" style="color:var(--neon-red)">0</b></div>
            <div class="stat-item"><span>PRECISÃO</span><b id="g-precisao">0%</b></div>
        </div>
    </div>

    <div class="grid-monitores" id="grid"></div>

<script>
    const URL_SERVIDOR = "https://multiplaskcmp.onrender.com";
    let estaEditando = false; 
    

const LISTA_COMPLETA = [
    { id: "NONE", nome: "❌ DESATIVAR SLOT" },
    /* --- SINTÉTICOS --- */
    { id: "R_10", nome: "📊 Volatility 10" },
    { id: "R_25", nome: "📊 Volatility 25" },
    { id: "R_50", nome: "📊 Volatility 50" },
    { id: "R_75", nome: "📊 Volatility 75" },
    { id: "R_100", nome: "📊 Volatility 100" },
    { id: "1HZ10V", nome: "📈 Volatility 10 (1s)" },
    { id: "1HZ25V", nome: "📈 Volatility 25 (1s)" },
    { id: "1HZ50V", nome: "📈 Volatility 50 (1s)" },
    { id: "1HZ75V", nome: "📈 Volatility 75 (1s)" },
    { id: "1HZ100V", nome: "📈 Volatility 100 (1s)" },
    { id: "BOOM300", nome: "💥 Boom 300" },
    { id: "BOOM500", nome: "💥 Boom 500" },
    { id: "BOOM1000", nome: "💥 Boom 1000" },
    { id: "CRASH300", nome: "📉 Crash 300" },
    { id: "CRASH500", nome: "📉 Crash 500" },
    { id: "CRASH1000", nome: "📉 Crash 1000" },
    { id: "ST50", nome: "🎢 Step Index" },

    /* --- FOREX MAJORS (Principais) --- */
    { id: "frxAUDUSD", nome: "💱 AUD/USD" },
    { id: "frxEURUSD", nome: "💱 EUR/USD" },
    { id: "frxGBPUSD", nome: "💱 GBP/USD" },
    { id: "frxNZDUSD", nome: "💱 NZD/USD" },
    { id: "frxUSDCAD", nome: "💱 USD/CAD" },
    { id: "frxUSDCHF", nome: "💱 USD/CHF" },
    { id: "frxUSDJPY", nome: "💱 USD/JPY" },

    /* --- FOREX MINORS (Secundários) --- */
    { id: "frxAUDCAD", nome: "💱 AUD/CAD" },
    { id: "frxAUDCHF", nome: "💱 AUD/CHF" },
    { id: "frxAUDJPY", nome: "💱 AUD/JPY" },
    { id: "frxAUDNZD", nome: "💱 AUD/NZD" },
    { id: "frxEURAUD", nome: "💱 EUR/AUD" },
    { id: "frxEURCAD", nome: "💱 EUR/CAD" },
    { id: "frxEURCHF", nome: "💱 EUR/CHF" },
    { id: "frxEURGBP", nome: "💱 EUR/GBP" },
    { id: "frxEURJPY", nome: "💱 EUR/JPY" },
    { id: "frxEURNZD", nome: "💱 EUR/NZD" },
    { id: "frxGBPAUD", nome: "💱 GBP/AUD" },
    { id: "frxGBPCAD", nome: "💱 GBP/CAD" },
    { id: "frxGBPCHF", nome: "💱 GBP/CHF" },
    { id: "frxGBPJPY", nome: "💱 GBP/JPY" },
    { id: "frxGBPNZD", nome: "💱 GBP/NZD" },
    { id: "frxNZDJPY", nome: "💱 NZD/JPY" },
    { id: "frxUSDMXN", nome: "💱 USD/MXN" },

    /* --- FOREX EXOTICS (Exóticos) --- */
    { id: "frxSGDJPY", nome: "💱 SGD/JPY" },
    { id: "frxEURNOK", nome: "💱 EUR/NOK" },
    { id: "frxEURPLN", nome: "💱 EUR/PLN" },
    { id: "frxEURSEK", nome: "💱 EUR/SEK" },
    { id: "frxUSDSGD", nome: "💱 USD/SGD" },

    /* --- METAIS E CRIPTOS --- */
    { id: "frxXAUUSD", nome: "🪙 OURO (XAU/USD)" },
    { id: "cryBTCUSD", nome: "₿ BITCOIN (BTC/USD)" },
    { id: "cryETHUSD", nome: "♢ ETHEREUM (ETH/USD)" }
];


    let localEstatutos = { "REGRA 1": true, "FLUXO SNIPER": true, "ZIGZAG FRACTAL": true, "SNIPER (RETRAÇÃO)": true };

    function criarMonitores() {
        const grid = document.getElementById('grid');
        let optionsHTML = LISTA_ATIVOS.map(a => `<option value="${a.id}">${a.nome}</option>`).join('');
        for (let i = 1; i <= 6; i++) {
            grid.innerHTML += `
                <div class="card" id="div-card${i}">
                    <div style="font-size:8px; color:#888;">MONITOR ${i}</div>
                    <div class="thermometer-wrap"><div class="thermometer-fill" id="therm-card${i}"></div></div>
                    <div class="status-box" id="status-card${i}">ANALISANDO VELAS</div>
                    <div class="price" id="price-card${i}">0.00000</div>
                    <select class="select-ativo" id="select-card${i}" onchange="mudarAtivo('card${i}')">
                        ${optionsHTML}
                    </select>
                </div>`;
        }
    }

    async function salvarTudo() {
        const banca = parseFloat(document.getElementById('inpBanca').value);
        const payout = parseFloat(document.getElementById('inpPayout').value);
        try {
            await fetch(`${URL_SERVIDOR}/config-financeira`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ banca, payout, estatutos: localEstatutos })
            });
            console.log("Configurações enviadas ao servidor.");
        } catch (e) { console.log("Erro ao salvar."); }
    }

    async function mudarAtivo(cardId) {
        const sel = document.getElementById(`select-${cardId}`);
        await fetch(`${URL_SERVIDOR}/mudar`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ cardId, ativoId: sel.value, nomeAtivo: sel.options[sel.selectedIndex].text })
        });
    }

    function toggleEstrat(nome) {
        localEstatutos[nome] = !localEstatutos[nome];
        const btn = document.getElementById(`btn-${nome}`);
        btn.innerText = localEstatutos[nome] ? "ATIVO" : "DESATIVADO";
        btn.classList.toggle('btn-off', !localEstatutos[nome]);
    }

    async function sincronizar() {
        if (estaEditando) return; 
        try {
            const res = await fetch(`${URL_SERVIDOR}/status`);
            const d = await res.json();
            document.getElementById('display-banca').innerText = "R$ " + d.global.banca;
            document.getElementById('display-lucro').innerText = "R$ " + d.global.lucro;
            document.getElementById('g-direto').innerText = d.global.winDireto;
            document.getElementById('g-gales').innerText = d.global.winGales;
            document.getElementById('g-loss').innerText = d.global.loss;
            document.getElementById('g-precisao').innerText = d.global.precisao + "%";
            
            d.ativos.forEach(a => {
                if(document.getElementById(`price-${a.cardId}`)) {
                    document.getElementById(`price-${a.cardId}`).innerText = a.preco;
                    document.getElementById(`status-${a.cardId}`).innerText = a.status;
                    if(a.forca) document.getElementById(`therm-${a.cardId}`).style.width = a.forca + "%";
                }
            });
        } catch (e) {}
    }

    function editarValor(elemento, valorAtual, callback, sufixo = "") {
        estaEditando = true;
        const input = document.createElement("input");
        input.type = "number";
        input.value = valorAtual;
        input.className = "fin-input";
        input.style.width = "100px";

        elemento.innerHTML = "";
        elemento.appendChild(input);
        input.focus();

        const finalizar = async () => {
            let novoValor = parseFloat(input.value) || valorAtual;
            await callback(novoValor);
            elemento.innerText = sufixo === "R$" ? `R$ ${novoValor.toFixed(2)}` : `${novoValor}${sufixo}`;
            setTimeout(() => { estaEditando = false; }, 1000);
        };

        input.onblur = finalizar;
        input.onkeydown = (e) => { if (e.key === "Enter") input.blur(); };
    }

    // ADICIONADO: Apenas o simulador mantém o duplo clique, a banca foi removida daqui
    document.getElementById("display-simulador").ondblclick = () => {
        let texto = document.getElementById("display-simulador").innerText.replace("%", "").trim();
        editarValor(document.getElementById("display-simulador"), parseFloat(texto), async (novo) => {
            document.getElementById("display-simulador").innerText = novo + "%";
        }, "%");
    };

    criarMonitores();
    setInterval(sincronizar, 1000);
</script>
</body> 
</html>
