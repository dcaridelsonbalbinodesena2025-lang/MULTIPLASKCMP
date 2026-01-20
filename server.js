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

let stats = {
    "FLUXO SNIPER": { win: 0, loss: 0, analises: 0 },
    "SNIPER (RETRAÇÃO)": { win: 0, loss: 0, analises: 0 },
    "ZIGZAG FRACTAL": { win: 0, loss: 0, analises: 0 }
};

let motores = {};

function enviarTelegram(msg, comBotao = true) {
    let payload = { chat_id: TG_CHAT_ID, text: msg, parse_mode: "Markdown" };
    if (comBotao) {
        payload.reply_markup = { inline_keyboard: [[{ text: "📲 ACESSAR CORRETORA", url: LINK_CORRETORA }]] };
    }
    fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }).catch(e => console.error("Erro Telegram:", e));
}

function iniciarMotor(cardId, ativoId, nomeAtivo) {
    if (motores[cardId]?.ws) motores[cardId].ws.close();
    if (ativoId === "OFF") {
        motores[cardId] = { nome: "OFF", status: "DESATIVADO", preco: "---", forca: 50, operacao: { ativa: false } };
        return;
    }

    let m = {
        nome: nomeAtivo,
        ws: new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089'),
        preco: "0.0000",
        forca: 50,
        aberturaVela: 0,
        historicoCores: [],
        alertaEnviado: false,
        operacao: { ativa: false, estrategia: "", precoEntrada: 0, tempo: 0, direcao: "" }
    };

    m.ws.on('open', () => m.ws.send(JSON.stringify({ ticks: ativoId })));

    m.ws.on('message', (data) => {
        const res = JSON.parse(data);
        if (!res.tick) return;
        
        const preco = res.tick.quote;
        const agora = new Date();
        const segs = agora.getSeconds();
        m.preco = preco.toFixed(5);
        
        if (m.aberturaVela > 0) {
            let diff = preco - m.aberturaVela;
            let calculoForca = 50 + (diff / (m.aberturaVela * 0.0002) * 20);
            m.forca = Math.min(98, Math.max(2, calculoForca));
        }

        if (segs === 0) {
            if (m.aberturaVela > 0) {
                m.historicoCores.push(preco > m.aberturaVela ? "VERDE" : "VERMELHA");
                if (m.historicoCores.length > 5) m.historicoCores.shift();
            }
            m.aberturaVela = preco;
            m.alertaEnviado = false; // Reseta alerta para a nova vela
        }

        // --- 1. ALERTAS (30 SEGUNDOS ANTES) ---
        if (segs === 30 && !m.operacao.ativa && !m.alertaEnviado) {
            let p_estr = "";
            let p_dir = "";

            let ultimas3 = m.historicoCores.slice(-3);
            if (ultimas3.length === 3 && ultimas3.every(c => c === "VERDE")) { p_estr = "FLUXO SNIPER"; p_dir = "COMPRA 🟢"; }
            else if (ultimas3.length === 3 && ultimas3.every(c => c === "VERMELHA")) { p_estr = "FLUXO SNIPER"; p_dir = "VENDA 🔴"; }

            if (!p_estr && m.historicoCores.length >= 2) {
                let p = m.historicoCores.slice(-2);
                if (p[0] === "VERDE" && p[1] === "VERMELHA") { p_estr = "ZIGZAG FRACTAL"; p_dir = "VENDA 🔴"; }
                else if (p[0] === "VERMELHA" && p[1] === "VERDE") { p_estr = "ZIGZAG FRACTAL"; p_dir = "COMPRA 🟢"; }
            }

            if (p_estr) {
                m.alertaEnviado = true;
                let proxMinuto = new Date(agora.getTime() + 30000).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                enviarTelegram(`⚠️ *ALERTA DE POSSÍVEL ENTRADA*\n\n🧠 Estratégia: *${p_estr}*\n📊 Ativo: ${m.nome}\n⚡ Direção: ${p_dir}\n⏰ Horário previsto: ${proxMinuto}\n\n_Fique atento para a confirmação!_`, false);
            }
        }

        // --- 2. ENTRADAS CONFIRMADAS (SEGUNDO 00) ---
        if (segs === 0 && !m.operacao.ativa) {
            let estr = "";
            let dir = "";
            let ultimas3 = m.historicoCores.slice(-3);
            
            if (ultimas3.length === 3 && ultimas3.every(c => c === "VERDE")) { estr = "FLUXO SNIPER"; dir = "CALL"; }
            else if (ultimas3.length === 3 && ultimas3.every(c => c === "VERMELHA")) { estr = "FLUXO SNIPER"; dir = "PUT"; }

            if (!estr && m.historicoCores.length >= 2) {
                let p = m.historicoCores.slice(-2);
                if (p[0] === "VERDE" && p[1] === "VERMELHA") { estr = "ZIGZAG FRACTAL"; dir = "PUT"; }
                else if (p[0] === "VERMELHA" && p[1] === "VERDE") { estr = "ZIGZAG FRACTAL"; dir = "CALL"; }
            }

            if (estr) {
                m.operacao = { ativa: true, estrategia: estr, precoEntrada: preco, tempo: 60, direcao: dir };
                let hI = agora.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'});
                let hF = new Date(agora.getTime() + 60000).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'});
                enviarTelegram(`✅ *ENTRADA CONFIRMADA (CLIQUE AGORA 🟢)*\n\n🔥 Estratégia: *${estr}*\n💎 Ativo: ${m.nome}\n📈 Ação: ${dir === "CALL" ? "COMPRA 🟢" : "VENDA 🔴"}\n⏰ Início: ${hI}\n🏁 Término: ${hF}`);
            }
        }

        // --- 3. SNIPER RETRAÇÃO (ALERTA AOS 40s E ENTRADA AOS 45s) ---
        if (segs === 40 && !m.operacao.ativa && !m.alertaEnviado) {
             let diff = (preco - m.aberturaVela) / m.aberturaVela * 1000;
             if (Math.abs(diff) > 0.6) {
                enviarTelegram(`🎯 *ALERTA: SNIPER (RETRAÇÃO)*\n📊 Ativo: ${m.nome}\n⚠️ Vela esticando! Prepare o clique...`, false);
                m.alertaEnviado = true;
             }
        }

        if (segs === 45 && !m.operacao.ativa) {
            let diffB = (preco - m.aberturaVela) / m.aberturaVela * 1000;
            if (Math.abs(diffB) > 0.7) {
                let dirB = diffB > 0 ? "PUT" : "CALL";
                m.operacao = { ativa: true, estrategia: "SNIPER (RETRAÇÃO)", precoEntrada: preco, tempo: 15, direcao: dirB };
                let hI = agora.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'});
                let hF = new Date(agora.getTime() + 15000).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'});
                enviarTelegram(`✅ *SNIPER CONFIRMADO (CLIQUE AGORA 🟢)*\n\n🎯 Estratégia: *SNIPER (RETRAÇÃO)*\n💎 Ativo: ${m.nome}\n📈 Ação: ${dirB === "CALL" ? "COMPRA 🟢" : "VENDA 🔴"}\n⏰ Início: ${hI}\n🏁 Término: ${hF}`);
            }
        }

        // --- GERENCIAMENTO DE RESULTADO ---
        if (m.operacao.ativa) {
            m.operacao.tempo--;
            if (m.operacao.tempo <= 0) {
                let win = (m.operacao.direcao === "CALL" && preco > m.operacao.precoEntrada) || 
                          (m.operacao.direcao === "PUT" && preco < m.operacao.precoEntrada);
                let e = m.operacao.estrategia;
                if (stats[e]) {
                    if (win) stats[e].win++; else stats[e].loss++;
                    stats[e].analises++;
                    enviarTelegram(`${win ? "✅" : "❌"} *RESULTADO: ${win ? "WIN" : "LOSS"}*\n\n🧠 Estratégia: *${e}*\n🌍 Ativo: ${m.nome}\n🟢 W: ${stats[e].win} | 🔴 L: ${stats[e].loss}`);
                }
                m.operacao.ativa = false;
            }
        }
    });
    motores[cardId] = m;
}

app.get('/status', (req, res) => {
    let ativosStatus = Object.keys(motores).map(id => ({
        cardId: id,
        nome: motores[id].nome,
        preco: motores[id].preco,
        status: motores[id].operacao?.ativa ? "OPERANDO..." : (motores[id].nome === "OFF" ? "DESATIVADO" : "ANALISANDO..."),
        forca: motores[id].forca || 50
    }));
    let totalWins = Object.values(stats).reduce((a, b) => a + b.win, 0);
    let totalAnalises = Object.values(stats).reduce((a, b) => a + b.analises, 0);
    let precisao = totalAnalises > 0 ? ((totalWins / totalAnalises) * 100).toFixed(1) : "0.0";
    res.json({ global: { winDireto: stats["FLUXO SNIPER"].win, winGales: stats["SNIPER (RETRAÇÃO)"].win, loss: Object.values(stats).reduce((a, b) => a + b.loss, 0), precisao: precisao }, ativos: ativosStatus });
});

app.post('/mudar', (req, res) => {
    const { cardId, ativoId, nomeAtivo } = req.body;
    iniciarMotor(cardId, ativoId, nomeAtivo);
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`Multi-Server ON na porta ${PORT}`));
