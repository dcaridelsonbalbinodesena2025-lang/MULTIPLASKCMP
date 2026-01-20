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

// --- GESTÃO FINANCEIRA ---
let fin = {
    bancaInicial: 5000,
    bancaAtual: 5000,
    payout: 0.95,
    lucroHoje: 0
};

function getHoraBrasilia() {
    return new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

let stats = {
    "REGRA 1": { d: 0, g1: 0, g2: 0, loss: 0, t: 0 },
    "FLUXO SNIPER": { d: 0, g1: 0, g2: 0, loss: 0, t: 0 },
    "SNIPER (RETRAÇÃO)": { d: 0, g1: 0, g2: 0, loss: 0, t: 0 },
    "ZIGZAG FRACTAL": { d: 0, g1: 0, g2: 0, loss: 0, t: 0 }
};

let motores = {};
for(let i=1; i<=6; i++) {
    motores[`card${i}`] = { nome: "OFF", status: "DESATIVADO", preco: "---", forca: 50 };
}

// --- RESET DIÁRIO (00:00) ---
cron.schedule('0 0 * * *', () => {
    fin.bancaAtual = fin.bancaInicial;
    fin.lucroHoje = 0;
    enviarTelegram("📅 *SIMULADOR DIÁRIO RESETADO*", false);
});

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
    let crescimento = ((fin.bancaAtual / fin.bancaInicial - 1) * 100).toFixed(2);
    return `🟢 ${wins}W | 🔴 ${losses}L\n💰 Banca: R$ ${fin.bancaAtual.toFixed(2)} (${crescimento}%)`;
}

// --- LÓGICA DO MOTOR ---
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
        buscandoTaxaRegra1: false,
        sinalPendenteRegra1: null,
        operacao: { ativa: false, estrategia: "", precoEntrada: 0, tempo: 0, direcao: "", gale: 0, valorInvestido: 0 }
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
            m.fechamentoAnterior = m.aberturaVela;
            m.aberturaVela = preco;
            if (!m.operacao.ativa && (m.forca >= 80 || m.forca <= 20)) {
                m.sinalPendenteRegra1 = m.forca >= 80 ? "CALL" : "PUT";
                m.buscandoTaxaRegra1 = true;
            }
        }

        if (m.buscandoTaxaRegra1 && !m.operacao.ativa) {
            let diffVela = Math.abs(m.fechamentoAnterior - m.aberturaVela) || 0.0001;
            let confirmou = (m.sinalPendenteRegra1 === "CALL" && preco <= (m.aberturaVela - (diffVela * 0.2))) || 
                            (m.sinalPendenteRegra1 === "PUT" && preco >= (m.aberturaVela + (diffVela * 0.2)));
            if (confirmou) {
                let valor = fin.bancaAtual * 0.01;
                fin.bancaAtual -= valor;
                m.operacao = { ativa: true, estrategia: "REGRA 1", precoEntrada: preco, tempo: 60, direcao: m.sinalPendenteRegra1, gale: 0, valorInvestido: valor };
                m.buscandoTaxaRegra1 = false;
                enviarTelegram(`🚀 *ENTRADA: REGRA 1*\n📊 Ativo: ${m.nome}\n💰 Valor: R$ ${valor.toFixed(2)}`);
            }
        }

        if (m.operacao.ativa) {
            m.operacao.tempo--;
            if (m.operacao.tempo <= 0) {
                let win = (m.operacao.direcao === "CALL" && preco > m.operacao.precoEntrada) || (m.operacao.direcao === "PUT" && preco < m.operacao.precoEntrada);
                let e = m.operacao.estrategia;
                if (win) {
                    let lucro = m.operacao.valorInvestido * fin.payout;
                    fin.bancaAtual += (m.operacao.valorInvestido + lucro);
                    stats[e].d++; stats[e].t++;
                    enviarTelegram(`✅ *WIN: ${e}*\n💰 Lucro: R$ ${lucro.toFixed(2)}\n${getPlacarGeral()}`);
                    m.operacao.ativa = false;
                } else if (m.operacao.gale < 2) {
                    m.operacao.gale++;
                    let valorGale = m.operacao.valorInvestido * 2;
                    fin.bancaAtual -= valorGale;
                    m.operacao.valorInvestido = valorGale;
                    m.operacao.tempo = 60;
                    m.operacao.precoEntrada = preco;
                } else {
                    stats[e].loss++; stats[e].t++;
                    enviarTelegram(`❌ *LOSS: ${e}*\n${getPlacarGeral()}`);
                    m.operacao.ativa = false;
                }
            }
        }
    });
    motores[cardId] = m;
}

// RELATÓRIO PDF (A cada 5 min)
setInterval(() => {
    let lucroS = (fin.bancaAtual - fin.bancaInicial).toFixed(2);
    let msg = `📄 *RELATÓRIO PARA PDF*\n⏰ ${getHoraBrasilia()}\n━━━━━━━━━━━━━━━\n💰 BANCA: R$ ${fin.bancaAtual.toFixed(2)}\n📈 LUCRO: R$ ${lucroS}\n📊 PLACAR: ${getPlacarGeral()}\n━━━━━━━━━━━━━━━`;
    enviarTelegram(msg, false);
}, 300000);

app.get('/status', (req, res) => {
    res.json({ global: { banca: fin.bancaAtual.toFixed(2), lucro: (fin.bancaAtual - fin.bancaInicial).toFixed(2) }, ativos: Object.keys(motores).map(id => ({ cardId: id, nome: motores[id].nome, status: motores[id].status })) });
});

app.post('/mudar', (req, res) => {
    iniciarMotor(req.body.cardId, req.body.ativoId, req.body.nomeAtivo);
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`Super Central ON`));
