const WebSocket = require('ws');
const fetch = require('node-fetch');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors()); // Libera a conexão com o painel index.html

const PORT = process.env.PORT || 3000; 

// --- CONFIGURAÇÕES ---
const TG_TOKEN = "8427077212:AAEiL_3_D_-fukuaR95V3FqoYYyHvdCHmEI"; 
const TG_CHAT_ID = "-1003355965894"; 
const LINK_CORRETORA = "https://track.deriv.com/_S_W1N_"; 

// Estatísticas Padronizadas
let stats = {
    "FLUXO RAIANE": { win: 0, loss: 0, analises: 0 },
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
        motores[cardId] = { nome: "OFF", status: "DESATIVADO", preco: "---", forca: 50 };
        return;
    }

    let m = {
        nome: nomeAtivo,
        ws: new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089'),
        preco: "0.0000",
        forca: 50,
        aberturaVela: 0,
        fechamentoAnterior: 0,
        historicoCores: [],
        operacao: { ativa: false, estrategia: "", precoEntrada: 0, tempo: 0, direcao: "" }
    };

    m.ws.on('open', () => m.ws.send(JSON.stringify({ ticks: ativoId })));

    m.ws.on('message', (data) => {
        const res = JSON.parse(data);
        if (!res.tick) return;
        
        const preco = res.tick.quote;
        const agora = new Date();
        const segs = agora.getSeconds();

        // ATUALIZAÇÃO EM TEMPO REAL PARA O PAINEL
        m.preco = preco.toFixed(5);
        
        // Cálculo de força para a barra do painel
        if (m.aberturaVela > 0) {
            let diff = preco - m.aberturaVela;
            let calculoForca = 50 + (diff / (m.aberturaVela * 0.0002) * 20);
            m.forca = Math.min(98, Math.max(2, calculoForca));
        }

        // Lógica de Vela (Minuto em Minuto)
        if (segs === 0) {
            if (m.aberturaVela > 0) {
                m.historicoCores.push(preco > m.aberturaVela ? "VERDE" : "VERMELHA");
                if (m.historicoCores.length > 5) m.historicoCores.shift();
            }
            m.fechamentoAnterior = preco;
            m.aberturaVela = preco;
        }

        // --- VERIFICAÇÃO DE ESTRATÉGIAS ---
        if (segs === 0 && !m.operacao.ativa) {
            let estr = "";
            let dir = "";

            let ultimas3 = m.historicoCores.slice(-3);
            if (ultimas3.length === 3 && ultimas3.every(c => c === "VERDE")) { estr = "FLUXO RAIANE"; dir = "CALL"; }
            else if (ultimas3.length === 3 && ultimas3.every(c => c === "VERMELHA")) { estr = "FLUXO RAIANE"; dir = "PUT"; }

            if (!estr && m.historicoCores.length >= 2) {
                let p = m.historicoCores.slice(-2);
                if (p[0] === "VERDE" && p[1] === "VERMELHA") { estr = "ZIGZAG FRACTAL"; dir = "PUT"; }
                else if (p[0] === "VERMELHA" && p[1] === "VERDE") { estr = "ZIGZAG FRACTAL"; dir = "CALL"; }
            }

            if (estr) {
                m.operacao = { ativa: true, estrategia: estr, precoEntrada: preco, tempo: 60, direcao: dir };
                enviarTelegram(`🚀 *ENTRADA CONFIRMADA*\n\n🔥 Estratégia: *${estr}*\n💎 Ativo: ${m.nome}\n📈 Ação: ${dir === "CALL" ? "COMPRA 🟢" : "VENDA 🔴"}`);
            }
        }

        // SNIPER BERMAN (Aos 45s)
        if (segs === 45 && !m.operacao.ativa) {
            let diffB = (preco - m.aberturaVela) / m.aberturaVela * 1000;
            if (Math.abs(diffB) > 0.7) {
                let dirB = diffB > 0 ? "PUT" : "CALL";
                m.operacao = { ativa: true, estrategia: "SNIPER (RETRAÇÃO)", precoEntrada: preco, tempo: 15, direcao: dirB };
                enviarTelegram(`🎯 *SNIPER (RETRAÇÃO)*\n💎 Ativo: ${m.nome}\n📈 Ação: ${dirB === "CALL" ? "COMPRA 🟢" : "VENDA 🔴"}`);
            }
        }

        // GERENCIAMENTO DE RESULTADO
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

// ROTA DE STATUS PARA O PAINEL
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

    res.json({ 
        global: { 
            winDireto: stats["FLUXO RAIANE"].win, 
            winGales: stats["SNIPER (RETRAÇÃO)"].win, 
            loss: Object.values(stats).reduce((a, b) => a + b.loss, 0),
            precisao: precisao
        }, 
        ativos: ativosStatus 
    });
});

app.post('/mudar', (req, res) => {
    const { cardId, ativoId, nomeAtivo } = req.body;
    iniciarMotor(cardId, ativoId, nomeAtivo);
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`Multi-Server ON na porta ${PORT}`));
