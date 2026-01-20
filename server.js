const WebSocket = require('ws');
const fetch = require('node-fetch');
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000; 

// --- CONFIGURAÇÕES ---
const TG_TOKEN = "8427077212:AAEiL_3_D_-fukuaR95V3FqoYYyHvdCHmEI"; 
const TG_CHAT_ID = "-1003355965894"; 
const LINK_CORRETORA = "https://track.deriv.com/_S_W1N_"; 

// --- AJUSTE DE HORÁRIOS (Altere aqui) ---
const HORA_INICIO = 8;  // Inicia às 08:00
const HORA_FIM = 23;    // Para às 23:00

function getHoraBrasilia(data = new Date()) {
    return data.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Estatísticas para o Ranking e Painel
let stats = {
    "REGRA 1": { d: 0, g1: 0, g2: 0, loss: 0, t: 0 },
    "FLUXO SNIPER": { d: 0, g1: 0, g2: 0, loss: 0, t: 0 },
    "SNIPER (RETRAÇÃO)": { d: 0, g1: 0, g2: 0, loss: 0, t: 0 },
    "ZIGZAG FRACTAL": { d: 0, g1: 0, g2: 0, loss: 0, t: 0 }
};

let fin = { bancaInicial: 5000, bancaAtual: 5000, payout: 0.95 };
let motores = {};

// Inicializa os cards para o painel não ficar vazio
for(let i=1; i<=6; i++) {
    motores[`card${i}`] = { nome: "OFF", status: "DESATIVADO", preco: "---", forca: 50 };
}

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

function getPlacarGeral() {
    let wins = Object.values(stats).reduce((a, b) => a + (b.d + b.g1 + b.g2), 0);
    let losses = Object.values(stats).reduce((a, b) => a + b.loss, 0);
    return `🟢 ${wins}W | 🔴 ${losses}L`;
}

// RESET DIÁRIO ÀS 00:00
cron.schedule('0 0 * * *', () => {
    fin.bancaAtual = fin.bancaInicial;
    for (let key in stats) {
        stats[key] = { d: 0, g1: 0, g2: 0, loss: 0, t: 0 };
    }
    enviarTelegram("♻️ *SISTEMA REINICIADO PARA O NOVO DIA*", false);
}, { timezone: "America/Sao_Paulo" });

function iniciarMotor(cardId, ativoId, nomeAtivo) {
    if (motores[cardId]?.ws) motores[cardId].ws.close();
    if (ativoId === "OFF") {
        motores[cardId] = { nome: "OFF", status: "DESATIVADO", preco: "---", forca: 50 };
        return;
    }

    let m = {
        nome: nomeAtivo,
        status: "MONITORANDO",
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
        const horaAtual = parseInt(agora.toLocaleTimeString('pt-BR', {timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false}));
        
        m.preco = preco.toFixed(5);
        const horarioPermitido = horaAtual >= HORA_INICIO && horaAtual < HORA_FIM;

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

            // 1. REGRA 1 (ALERTA)
            if (!m.operacao.ativa && horarioPermitido && (m.forca >= 80 || m.forca <= 20)) {
                m.sinalPendenteRegra1 = m.forca >= 80 ? "CALL" : "PUT";
                m.buscandoTaxaRegra1 = true;
                enviarTelegram(`🔍 *ALERTA: REGRA 1*\n📊 Ativo: ${m.nome}\n⚡ Direção: ${m.sinalPendenteRegra1 === "CALL" ? "COMPRA 🟢" : "VENDA 🔴"}`, false);
            }
        }

        // ENTRADA REGRA 1 (Taxa)
        if (m.buscandoTaxaRegra1 && !m.operacao.ativa && horarioPermitido) {
            let diffVela = Math.abs(m.fechamentoAnterior - m.aberturaVela) || 0.0001;
            let confirmou = (m.sinalPendenteRegra1 === "CALL" && preco <= (m.aberturaVela - (diffVela * 0.2))) || 
                            (m.sinalPendenteRegra1 === "PUT" && preco >= (m.aberturaVela + (diffVela * 0.2)));
            if (confirmou) {
                m.operacao = { ativa: true, estrategia: "REGRA 1", precoEntrada: preco, tempo: 60, direcao: m.sinalPendenteRegra1, gale: 0 };
                m.buscandoTaxaRegra1 = false;
                enviarTelegram(`🚀 *ENTRADA: REGRA 1*\n📊 Ativo: ${m.nome}\n🎯 Direção: ${m.operacao.direcao}`);
            }
        }

        // 2 e 3. FLUXO / ZIGZAG (30s)
        if (segs === 30 && !m.operacao.ativa && !m.alertaEnviado && horarioPermitido) {
            let p_estr = ""; let p_dir = "";
            let ult3 = m.historicoCores.slice(-3);
            if (ult3.every(c => c === "VERDE")) { p_estr = "FLUXO SNIPER"; p_dir = "CALL"; }
            else if (m.forca > 75) { p_estr = "ZIGZAG FRACTAL"; p_dir = "PUT"; }

            if (p_estr) {
                m.operacao = { ativa: true, estrategia: p_estr, precoEntrada: preco, tempo: 30, direcao: p_dir, gale: 0 };
                enviarTelegram(`⚡ *ENTRADA: ${p_estr}*\n📊 Ativo: ${m.nome}\n🎯 Direção: ${p_dir}`);
            }
        }

        // 4. SNIPER RETRAÇÃO (45s)
        if (segs === 45 && !m.operacao.ativa && horarioPermitido) {
            let diffB = (preco - m.aberturaVela) / m.aberturaVela * 1000;
            if (Math.abs(diffB) > 0.7) {
                let dR = diffB > 0 ? "PUT" : "CALL";
                m.operacao = { ativa: true, estrategia: "SNIPER (RETRAÇÃO)", precoEntrada: preco, tempo: 15, direcao: dR, gale: 0 };
                enviarTelegram(`✅ *ENTRADA: SNIPER (RETRAÇÃO)*\n📊 Ativo: ${m.nome}\n🎯 Direção: ${dR}`);
            }
        }

        // RESULTADOS
        if (m.operacao.ativa) {
            m.operacao.tempo--;
            if (m.operacao.tempo <= 0) {
                let win = (m.operacao.direcao === "CALL" && preco > m.operacao.precoEntrada) || (m.operacao.direcao === "PUT" && preco < m.operacao.precoEntrada);
                let e = m.operacao.estrategia;
                if (win) {
                    if (m.operacao.gale === 0) stats[e].d++; else if (m.operacao.gale === 1) stats[e].g1++; else stats[e].g2++;
                    stats[e].t++;
                    enviarTelegram(`✅ *WIN: ${e}*\n📊 Ativo: ${m.nome}\n🎯 Placar: ${getPlacarGeral()}`);
                    m.operacao.ativa = false;
                } else if (m.operacao.gale < 2) {
                    m.operacao.gale++; m.operacao.tempo = 60; m.operacao.precoEntrada = preco;
                    enviarTelegram(`🔄 *GALE ${m.operacao.gale}: ${e}* - ${m.nome}`);
                } else {
                    stats[e].loss++; stats[e].t++;
                    enviarTelegram(`❌ *LOSS: ${e}*\n📊 Ativo: ${m.nome}\n🎯 Placar: ${getPlacarGeral()}`);
                    m.operacao.ativa = false;
                }
            }
        }
    });
    motores[cardId] = m;
}

// RELATÓRIO PARA PDF / RANKING (A cada 5 min)
setInterval(() => {
    let msg = `📄 *RELATÓRIO PARA PDF*\n⏰ ${getHoraBrasilia()}\n━━━━━━━━━━━━━━━━\n💰 BANCA: R$ ${fin.bancaAtual.toFixed(2)}\n📊 PLACAR: ${getPlacarGeral()}\n━━━━━━━━━━━━━━━━\n🏆 *RANKING:*`;
    for (let key in stats) {
        let wins = stats[key].d + stats[key].g1 + stats[key].g2;
        msg += `\n• ${key}: ${wins}W | ${stats[key].loss}L`;
    }
    enviarTelegram(msg, false);
}, 300000);

// ROTA PARA O PAINEL (Evita o Undefined)
app.get('/status', (req, res) => {
    let totalWins = Object.values(stats).reduce((a, b) => a + (b.d + b.g1 + b.g2), 0);
    let totalLoss = Object.values(stats).reduce((a, b) => a + b.loss, 0);
    res.json({
        global: {
            winDireto: totalWins, // Agrupado para simplificar o painel
            winGales: 0,
            loss: totalLoss,
            banca: fin.bancaAtual.toFixed(2),
            lucro: (fin.bancaAtual - fin.bancaInicial).toFixed(2)
        },
        ativos: Object.keys(motores).map(id => ({
            cardId: id,
            nome: motores[id].nome,
            preco: motores[id].preco,
            forca: motores[id].forca,
            status: motores[id].status || "OFF"
        }))
    });
});

app.post('/mudar', (req, res) => {
    iniciarMotor(req.body.cardId, req.body.ativoId, req.body.nomeAtivo);
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`Super Central ON`));
