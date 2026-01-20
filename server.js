const WebSocket = require('ws');
const fetch = require('node-fetch');
const express = require('express');

const app = express();
app.use(express.json());

const PORT = 3001; // Porta diferente para não dar conflito com o seu oficial

// --- CONFIGURAÇÕES ---
const TG_TOKEN = "8427077212:AAEiL_3_D_-fukuaR95V3FqoYYyHvdCHmEI"; 
const TG_CHAT_ID = "-1003355965894"; 
const LINK_CORRETORA = "https://track.deriv.com/_S_W1N_"; 

// Estatísticas Separadas por Estratégia
let stats = {
    "FLUXO RAIANE": { win: 0, loss: 0, analises: 0 },
    "SNIPER BERMAN": { win: 0, loss: 0, analises: 0 },
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

    let m = {
        nome: nomeAtivo,
        ws: new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089'),
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

        // Lógica de Vela
        if (segs === 0) {
            if (m.aberturaVela > 0) {
                m.historicoCores.push(preco > m.aberturaVela ? "VERDE" : "VERMELHA");
                if (m.historicoCores.length > 5) m.historicoCores.shift();
            }
            m.fechamentoAnterior = preco;
            m.aberturaVela = preco;
        }

        // --- VERIFICAÇÃO DE ESTRATÉGIAS (ALERTA AOS 00s) ---
        if (segs === 0 && !m.operacao.ativa) {
            let estr = "";
            let dir = "";

            // 1. Lógica RAIANE (Fluxo de 3 velas iguais)
            let ultimas3 = m.historicoCores.slice(-3);
            if (ultimas3.length === 3 && ultimas3.every(c => c === "VERDE")) { estr = "FLUXO SNIPER"; dir = "CALL"; }
            else if (ultimas3.length === 3 && ultimas3.every(c => c === "VERMELHA")) { estr = "FLUXO SNAIPER"; dir = "PUT"; }

            // 2. Lógica ZIGZAG (Reversão de Padrão)
            if (!estr && m.historicoCores.length >= 2) {
                let p = m.historicoCores.slice(-2);
                if (p[0] === "VERDE" && p[1] === "VERMELHA") { estr = "ZIGZAG FRACTAL"; dir = "PUT"; }
                else if (p[0] === "VERMELHA" && p[1] === "VERDE") { estr = "ZIGZAG FRACTAL"; dir = "CALL"; }
            }

            if (estr) {
                let hA = agora.toLocaleTimeString();
                enviarTelegram(`🔍 *ALERTA: OPORTUNIDADE*\n\n🧠 Estratégia: *${estr}*\n📊 Ativo: ${m.nome}\n⚡ Direção: ${dir === "CALL" ? "COMPRA 🟢" : "VENDA 🔴"}\n⏰ Horário: ${hA}`, false);
                
                // Confirmação Imediata (ou você pode add delay aqui)
                m.operacao = { ativa: true, estrategia: estr, precoEntrada: preco, tempo: 60, direcao: dir };
                let hI = agora.toLocaleTimeString();
                let hF = new Date(agora.getTime() + 60000).toLocaleTimeString();
                enviarTelegram(`🚀 *ENTRADA CONFIRMADA*\n\n🔥 Estratégia: *${estr}*\n💎 Ativo: ${m.nome}\n📈 Ação: ${dir === "CALL" ? "COMPRA 🟢" : "VENDA 🔴"}\n⏰ Início: ${hI}\n🏁 Término: ${hF}`);
            }
        }

        // 3. Lógica BERMAN (Sniper de Exaustão aos 45s)
        if (segs === 45 && !m.operacao.ativa) {
            let diff = (preco - m.aberturaVela) / m.aberturaVela * 1000;
            if (Math.abs(diff) > 0.7) { // Esticada forte
                let dirB = diff > 0 ? "PUT" : "CALL";
                m.operacao = { ativa: true, estrategia: "SNIPER (RETRAÇÃO)", precoEntrada: preco, tempo: 15, direcao: dirB };
                enviarTelegram(`🎯 *SNIPER (RETRAÇÃO)*\n💎 Ativo: ${m.nome}\n📈 Ação: ${dirB === "CALL" ? "COMPRA 🟢" : "VENDA 🔴"}\n⏱ Expiração: Final da Vela`);
            }
        }

        // --- GERENCIAMENTO DE RESULTADO ---
        if (m.operacao.ativa) {
            m.operacao.tempo--;
            if (m.operacao.tempo <= 0) {
                let win = (m.operacao.direcao === "CALL" && preco > m.operacao.precoEntrada) || 
                          (m.operacao.direcao === "PUT" && preco < m.operacao.precoEntrada);
                
                let e = m.operacao.estrategia;
                if (win) stats[e].win++; else stats[e].loss++;
                stats[e].analises++;

                enviarTelegram(`${win ? "✅" : "❌"} *RESULTADO: ${win ? "WIN" : "LOSS"}*\n\n🧠 Estratégia: *${e}*\n🌍 Ativo: ${m.nome}\n\n📊 *PLACAR ${e}:*\n🟢 WINS: ${stats[e].win}\n🔴 LOSS: ${stats[e].loss}`);
                m.operacao.ativa = false;
            }
        }
    });
    motores[cardId] = m;
}

// --- RELATÓRIO MULTI-ESTRATÉGIA (5 MINUTOS) ---
function enviarRelatorioMulti() {
    let msg = `📊 *RELATÓRIO MULTI-ESTRATÉGIA*\n\n`;
    
    for (let e in stats) {
        let total = stats[e].analises;
        let ef = total > 0 ? ((stats[e].win / total) * 100).toFixed(1) : "0.0";
        msg += `🧠 *${e}*:\n• Analises: ${total}\n• Placar: ${stats[e].win}W - ${stats[e].loss}L\n• Eficiência: ${ef}%\n\n`;
    }

    enviarTelegram(msg, false);
}
setInterval(enviarRelatorioMulti, 300000);

app.post('/mudar', (req, res) => {
    const { cardId, ativoId, nomeAtivo } = req.body;
    iniciarMotor(cardId, ativoId, nomeAtivo);
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`Multi-Server ON na porta ${PORT}`));
