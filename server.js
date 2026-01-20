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

function getHoraBrasilia(data = new Date()) {
    return data.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Estatísticas para o Ranking
let stats = {
    "REGRA 1": { d: 0, g1: 0, g2: 0, loss: 0, t: 0 },
    "FLUXO SNIPER": { d: 0, g1: 0, g2: 0, loss: 0, t: 0 },
    "SNIPER (RETRAÇÃO)": { d: 0, g1: 0, g2: 0, loss: 0, t: 0 },
    "ZIGZAG FRACTAL": { d: 0, g1: 0, g2: 0, loss: 0, t: 0 }
};

let motores = {};

function enviarTelegram(msg, comBotao = true) {
    let payload = { chat_id: TG_CHAT_ID, text: msg, parse_mode: "Markdown" };
    if (comBotao) {
        payload.reply_markup = { inline_keyboard: { text: "📲 ACESSAR CORRETORA", url: LINK_CORRETORA } };
    }
    fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }).catch(e => console.error("Erro Telegram:", e));
}

function getPlacarGeral() {
    let wins = Object.values(stats).reduce((a, b) => a + (b.d + b.g1 + b.g2), 0);
    let losses = Object.values(stats).reduce((a, b) => a + b.loss, 0);
    return `🟢 ${wins}W | 🔴 ${losses}L`;
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
        alertaEnviado: false,
        buscandoTaxaRegra1: false,
        sinalPendenteRegra1: null,
        operacao: { ativa: false, estrategia: "", precoEntrada: 0, tempo: 0, direcao: "", gale: 0 }
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
            m.forca = Math.min(98, Math.max(2, 50 + (diff / (m.aberturaVela * 0.0002) * 20)));
        }

        if (segs === 0) {
            if (m.aberturaVela > 0) {
                m.historicoCores.push(preco > m.aberturaVela ? "VERDE" : "VERMELHA");
                if (m.historicoCores.length > 5) m.historicoCores.shift();
            }
            m.fechamentoAnterior = m.aberturaVela;
            m.aberturaVela = preco;
            m.alertaEnviado = false;

            // ALERTA REGRA 1
            if (!m.operacao.ativa && (m.forca >= 80 || m.forca <= 20)) {
                m.sinalPendenteRegra1 = m.forca >= 80 ? "CALL" : "PUT";
                m.buscandoTaxaRegra1 = true;
                enviarTelegram(`🔍 *ALERTA: REGRA 1*\n📊 Ativo: ${m.nome}\n⚡ Direção: ${m.sinalPendenteRegra1 === "CALL" ? "COMPRA 🟢" : "VENDA 🔴"}\n⏰ Início previsto: ${getHoraBrasilia()}`, false);
            }
        }

        // ENTRADA REGRA 1 (Busca de Taxa)
        if (m.buscandoTaxaRegra1 && !m.operacao.ativa) {
            let diffVela = Math.abs(m.fechamentoAnterior - m.aberturaVela) || 0.0001;
            let confirmou = (m.sinalPendenteRegra1 === "CALL" && preco <= (m.aberturaVela - (diffVela * 0.2))) || 
                            (m.sinalPendenteRegra1 === "PUT" && preco >= (m.aberturaVela + (diffVela * 0.2)));
            if (confirmou) {
                m.operacao = { ativa: true, estrategia: "REGRA 1", precoEntrada: preco, tempo: 60, direcao: m.sinalPendenteRegra1, gale: 0 };
                m.buscandoTaxaRegra1 = false;
                enviarTelegram(`🚀 *ENTRADA: REGRA 1*\n📊 Ativo: ${m.nome}\n⚡ Direção: ${m.operacao.direcao === "CALL" ? "COMPRA 🟢" : "VENDA 🔴"}\n⏰ Início: ${getHoraBrasilia()}\n🏁 Fim: ${getHoraBrasilia(new Date(agora.getTime()+60000))}`);
            }
        }

        // ALERTAS 30s (FLUXO/ZIGZAG)
        if (segs === 30 && !m.operacao.ativa && !m.alertaEnviado && !m.buscandoTaxaRegra1) {
            let p_estr = ""; let p_dir = "";
            let ult3 = m.historicoCores.slice(-3);
            if (ult3.length === 3 && ult3.every(c => c === "VERDE")) { p_estr = "FLUXO SNIPER"; p_dir = "COMPRA 🟢"; }
            else if (ult3.length === 3 && ult3.every(c => c === "VERMELHA")) { p_estr = "FLUXO SNIPER"; p_dir = "VENDA 🔴"; }
            if (p_estr) {
                m.alertaEnviado = true;
                enviarTelegram(`⚠️ *ALERTA: ${p_estr}*\n📊 Ativo: ${m.nome}\n⚡ Direção: ${p_dir}\n⏰ Início previsto: ${getHoraBrasilia(new Date(agora.getTime()+30000)).slice(0,5)}`, false);
            }
        }

        // SNIPER RETRAÇÃO (45s)
        if (segs === 45 && !m.operacao.ativa) {
            let diffB = (preco - m.aberturaVela) / m.aberturaVela * 1000;
            if (Math.abs(diffB) > 0.7) {
                let dR = diffB > 0 ? "PUT" : "CALL";
                m.operacao = { ativa: true, estrategia: "SNIPER (RETRAÇÃO)", precoEntrada: preco, tempo: 15, direcao: dR, gale: 0 };
                enviarTelegram(`✅ *ENTRADA: SNIPER (RETRAÇÃO)*\n📊 Ativo: ${m.nome}\n⚡ Direção: ${dR === "CALL" ? "COMPRA 🟢" : "VENDA 🔴"}\n⏰ Início: ${getHoraBrasilia()}\n🏁 Fim: ${getHoraBrasilia(new Date(agora.getTime()+15000))}`);
            }
        }

        // RESULTADOS E GALES
        if (m.operacao.ativa) {
            m.operacao.tempo--;
            if (m.operacao.tempo <= 0) {
                let win = (m.operacao.direcao === "CALL" && preco > m.operacao.precoEntrada) || (m.operacao.direcao === "PUT" && preco < m.operacao.precoEntrada);
                let e = m.operacao.estrategia;
                let maxG = (e === "REGRA 1") ? 2 : 1;

                if (win) {
                    if (m.operacao.gale === 0) stats[e].d++; else if (m.operacao.gale === 1) stats[e].g1++; else stats[e].g2++;
                    stats[e].t++;
                    enviarTelegram(`✅ *WIN: ${e}*\n📊 Ativo: ${m.nome}\n🎯 Resultado: ${m.operacao.gale > 0 ? 'Gale '+m.operacao.gale : 'Direto'}\n📊 PLACAR: ${getPlacarGeral()}`);
                    m.operacao.ativa = false;
                } else if (m.operacao.gale < maxG) {
                    m.operacao.gale++; m.operacao.tempo = 60; m.operacao.precoEntrada = preco;
                    enviarTelegram(`🔄 *GALE ${m.operacao.gale}: ${e}*\n📊 Ativo: ${m.nome}\n⚡ Direção: ${m.operacao.direcao === "CALL" ? "COMPRA 🟢" : "VENDA 🔴"}\n⏰ Início: ${getHoraBrasilia()}\n🏁 Fim: ${getHoraBrasilia(new Date(agora.getTime()+60000))}`);
                } else {
                    stats[e].loss++; stats[e].t++;
                    enviarTelegram(`❌ *LOSS: ${e}*\n📊 Ativo: ${m.nome}\n📊 PLACAR: ${getPlacarGeral()}`);
                    m.operacao.ativa = false;
                }
            }
        }
    });
    motores[cardId] = m;
}

// RELATÓRIO DE RANKING (A cada 5 min)
setInterval(() => {
    let ranking = Object.keys(stats).map(key => {
        let s = stats[key];
        let wins = s.d + s.g1 + s.g2;
        let efD = s.t > 0 ? ((s.d / s.t) * 100).toFixed(1) : "0.0";
        let efF = s.t > 0 ? ((wins / s.t) * 100).toFixed(1) : "0.0";
        return { nome: key, ...s, wins, efD, efF };
    }).sort((a, b) => b.efF - a.efF);

    let msg = `🏆 *RANKING DE ESTRATÉGIAS*\n\n`;
    ranking.forEach((est, i) => {
        msg += `${i+1}º *${est.nome}*\n• Análises: ${est.t} | Red: ${est.loss}\n• Wins: D: ${est.d} | G1: ${est.g1} | G2: ${est.g2}\n• Efic. Direta: ${est.efD}% | *Efic. Total: ${est.efF}%*\n\n`;
    });
    msg += `📊 *TOTAL DO SISTEMA: ${getPlacarGeral()}*`;
    enviarTelegram(msg, false);
}, 300000);

app.post('/mudar', (req, res) => {
    const { cardId, ativoId, nomeAtivo } = req.body;
    iniciarMotor(cardId, ativoId, nomeAtivo);
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`Super Central ON`));
