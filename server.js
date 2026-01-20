const WebSocket = require('ws');
const fetch = require('node-fetch');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000; 

// --- CONFIGURAÇÕES ---
const HORA_INICIO = 8;  
const HORA_FIM = 23;    
const TG_TOKEN = "8427077212:AAEiL_3_D_-fukuaR95V3FqoYYyHvdCHmEI"; 
const TG_CHAT_ID = "-1003355965894"; 
const LINK_CORRETORA = "https://track.deriv.com/_S_W1N_"; 

// --- BANCA E ESTATÍSTICAS DETALHADAS ---
let fin = { bancaInicial: 5000, bancaAtual: 5000, payout: 0.95, perdaTotal: 0 };
let stats = { winDireto: 0, winG1: 0, winG2: 0, loss: 0, totalAnalises: 0, totalG1: 0, totalG2: 0 };

let rankingEstrategias = {
    "REGRA 1": { d: 0, g1: 0, g2: 0, l: 0, t: 0 },
    "FLUXO SNIPER": { d: 0, g1: 0, g2: 0, l: 0, t: 0 },
    "ZIGZAG FRACTAL": { d: 0, g1: 0, g2: 0, l: 0, t: 0 },
    "SNIPER (RETRAÇÃO)": { d: 0, g1: 0, g2: 0, l: 0, t: 0 }
};

let rankingAtivos = {}; 
let motores = {};

function getBrasiliaTime(date = new Date()) {
    return date.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function enviarTelegram(msg, comBotao = true) {
    let payload = { chat_id: TG_CHAT_ID, text: msg, parse_mode: "Markdown" };
    if (comBotao) payload.reply_markup = { inline_keyboard: [[{ text: "📲 ACESSAR CORRETORA", url: LINK_CORRETORA }]] };
    fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }).catch(e => {});
}

function updateAtivo(nome, tipo) {
    if (!rankingAtivos[nome]) rankingAtivos[nome] = { win: 0, loss: 0 };
    if (tipo === 'win') rankingAtivos[nome].win++;
    else rankingAtivos[nome].loss++;
}

// --- MENSAGENS PADRONIZADAS ---

function msgAlerta(m, est, dir) {
    enviarTelegram(`🔍 *ALERTA DE SINAL*\n\n📊 Ativo: ${m.nome}\n⚡ Estratégia: ${est}\n🎯 Direção: ${dir}\n⏰ Entrada prevista: ${getBrasiliaTime()}`, false);
}

function msgEntrada(m, est, dir, fim) {
    let placar = `🟢 ${stats.winDireto + stats.winG1 + stats.winG2}W | 🔴 ${stats.loss}L`;
    enviarTelegram(`🚀 *ENTRADA CONFIRMADA*\n\n📊 Ativo: ${m.nome}\n⚡ Estratégia: ${est}\n🎯 Direção: ${dir === "CALL" ? "COMPRA 🟢" : "VENDA 🔴"}\n🕒 Início: ${getBrasiliaTime()}\n🏁 Fim: ${getBrasiliaTime(fim)}\n📈 Placar: ${placar}`);
}

function msgGale(m, est, dir, nivel, fim) {
    enviarTelegram(`🔄 *ENTRADA NO GALE ${nivel}*\n\n📊 Ativo: ${m.nome}\n⚡ Estratégia: ${est}\n🎯 Direção: ${dir === "CALL" ? "COMPRA 🟢" : "VENDA 🔴"}\n🕒 Início: ${getBrasiliaTime()}\n🏁 Fim: ${getBrasiliaTime(fim)}`);
}

function msgResultado(m, est, res, status) {
    let emoji = res === 'WIN' ? '✅' : '❌';
    let placar = `🟢 ${stats.winDireto + stats.winG1 + stats.winG2}W | 🔴 ${stats.loss}L`;
    enviarTelegram(`${emoji} *RESULTADO: ${res === 'WIN' ? 'GREEN' : 'RED'}*\n\n🚦 Status: ${status}\n📊 Ativo: ${m.nome}\n⚡ Estratégia: ${est}\n📈 Placar: ${placar}`);
}

// --- MOTOR DE OPERAÇÕES ---

function iniciarMotor(cardId, ativoId, nomeAtivo) {
    if (motores[cardId]?.ws) motores[cardId].ws.close();
    if (ativoId === "OFF") return motores[cardId] = { nome: "OFF", status: "OFF", preco: "---", forca: 50 };

    let m = {
        nome: nomeAtivo, status: "MONITORANDO",
        ws: new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089'),
        preco: "0.0000", forca: 50, velaAb: 0, fechamentoAnt: 0, histCores: [],
        sinalPendenteR1: null, buscandoTaxaR1: false,
        op: { ativa: false, est: "", pre: 0, t: 0, dir: "", g: 0, val: 0 }
    };

    m.ws.on('open', () => m.ws.send(JSON.stringify({ ticks: ativoId })));
    m.ws.on('message', (data) => {
        const res = JSON.parse(data);
        if (!res.tick) return;
        const p = res.tick.quote;
        const s = new Date().getSeconds();
        const h = parseInt(new Date().toLocaleTimeString('pt-BR', {timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false}));
        m.preco = p.toFixed(5);
        const podeOp = h >= HORA_INICIO && h < HORA_FIM;

        if (m.velaAb > 0) m.forca = Math.min(98, Math.max(2, 50 + ((p - m.velaAb) / (m.velaAb * 0.0002) * 20)));

        if (s === 0) { 
            if (m.velaAb > 0) m.histCores.push(p > m.velaAb ? "V" : "R");
            if (m.histCores.length > 5) m.histCores.shift();
            m.fechamentoAnt = m.velaAb;
            m.velaAb = p;

            if (!m.op.ativa && podeOp && (m.forca >= 82 || m.forca <= 18)) {
                m.sinalPendenteR1 = m.forca >= 82 ? "CALL" : "PUT";
                m.buscandoTaxaR1 = true;
                msgAlerta(m, "REGRA 1", m.sinalPendenteR1);
            }
        }

        if (m.buscandoTaxaR1 && !m.op.ativa && podeOp) {
            let diffV = Math.abs(m.fechamentoAnt - m.velaAb) || 0.0001;
            let confirmou = (m.sinalPendenteR1 === "CALL" && p <= (m.velaAb - (diffV * 0.2))) || 
                            (m.sinalPendenteR1 === "PUT" && p >= (m.velaAb + (diffV * 0.2)));
            if (confirmou) {
                disparar(m, "REGRA 1", m.sinalPendenteR1, fin.bancaAtual * 0.01, p, 60);
                m.buscandoTaxaR1 = false;
            }
        }

        if (s === 30 && !m.op.ativa && podeOp && !m.buscandoTaxaR1) {
            let ult3 = m.histCores.slice(-3);
            if (ult3.length === 3 && ult3.every(c => c === "V")) {
                disparar(m, "FLUXO SNIPER", "CALL", fin.bancaAtual * 0.01, p, 30);
            } else if (ult3.length === 3 && ult3.every(c => c === "R")) {
                disparar(m, "FLUXO SNIPER", "PUT", fin.bancaAtual * 0.01, p, 30);
            } else if (m.forca > 80) {
                disparar(m, "ZIGZAG FRACTAL", "PUT", fin.bancaAtual * 0.01, p, 30);
            } else if (m.forca < 20) {
                disparar(m, "ZIGZAG FRACTAL", "CALL", fin.bancaAtual * 0.01, p, 30);
            }
        }

        if (s === 45 && !m.op.ativa && podeOp) {
            let diffP = (p - m.velaAb) / m.velaAb * 1000;
            if (Math.abs(diffP) > 0.8) disparar(m, "SNIPER (RETRAÇÃO)", diffP > 0 ? "PUT" : "CALL", fin.bancaAtual * 0.01, p, 15);
        }

        if (m.op.ativa) {
            m.op.t--;
            if (m.op.t <= 0) {
                let ganhou = (m.op.dir === "CALL" && p > m.op.pre) || (m.op.dir === "PUT" && p < m.op.pre);
                let est = m.op.est;
                if (ganhou) {
                    let lucro = m.op.val * fin.payout; fin.bancaAtual += (m.op.val + lucro);
                    let status = m.op.g === 0 ? "DIRETO" : `GALE ${m.op.g}`;
                    if(m.op.g===0) { stats.winDireto++; rankingEstrategias[est].d++; }
                    else if(m.op.g===1) { stats.winG1++; rankingEstrategias[est].g1++; }
                    else { stats.winG2++; rankingEstrategias[est].g2++; }
                    stats.totalAnalises++; rankingEstrategias[est].t++;
                    msgResultado(m, est, 'WIN', status);
                    updateAtivo(m.nome, 'win');
                    m.op.ativa = false;
                } else if (m.op.g < (est === "REGRA 1" ? 2 : 1)) {
                    m.op.g++; 
                    if(m.op.g === 1) stats.totalG1++; else stats.totalG2++;
                    m.op.val *= 2; fin.bancaAtual -= m.op.val;
                    m.op.t = 60; m.op.pre = p;
                    msgGale(m, est, m.op.dir, m.op.g, new Date(Date.now() + 60000));
                } else {
                    stats.loss++; stats.totalAnalises++; rankingEstrategias[est].l++; rankingEstrategias[est].t++;
                    fin.perdaTotal += m.op.val;
                    msgResultado(m, est, 'LOSS', `LOSS GALE ${m.op.g}`);
                    updateAtivo(m.nome, 'loss');
                    m.op.ativa = false;
                }
            }
        }
    });
    motores[cardId] = m;
}

function disparar(m, est, dir, val, pre, t) {
    fin.bancaAtual -= val;
    m.op = { ativa: true, est: est, pre: pre, t: t, dir: dir, g: 0, val: val };
    msgEntrada(m, est, dir, new Date(Date.now() + t * 1000));
}

// --- RELATÓRIO PDF ---
setInterval(() => {
    let totalWins = stats.winDireto + stats.winG1 + stats.winG2;
    let efSemGale = stats.totalAnalises > 0 ? ((stats.winDireto / stats.totalAnalises) * 100).toFixed(1) : 0;
    let efComGale = stats.totalAnalises > 0 ? ((totalWins / stats.totalAnalises) * 100).toFixed(1) : 0;
    
    let rAtivos = Object.entries(rankingAtivos).sort((a,b) => b[1].win - a[1].win);
    let melhorAtivo = rAtivos[0] ? rAtivos[0][0] : "---";
    let piorAtivo = rAtivos.length > 1 ? rAtivos[rAtivos.length-1][0] : "---";

    let msg = `📄 *RELATÓRIO DE PERFORMANCE*\n⏰ ${getBrasiliaTime()}\n\n`;
    msg += `📊 *ESTATÍSTICAS GERAIS*\n• Analises: ${stats.totalAnalises}\n• Win Direto: ${stats.winDireto}\n• Win com Gale: ${stats.winG1 + stats.winG2}\n• Red: ${stats.loss}\n`;
    msg += `• Green G1: ${stats.winG1} | Green G2: ${stats.winG2}\n\n`;
    msg += `🏆 *RANKING ATIVOS*\n• Melhor: ${melhorAtivo}\n• Pior: ${piorAtivo}\n\n`;
    msg += `🎯 *ASSERTIVIDADE*\n• Sem Gale: ${efSemGale}%\n• Com Gale: ${efComGale}%\n\n`;
    msg += `💰 *FINANCEIRO*\n• Banca: R$ ${fin.bancaAtual.toFixed(2)}\n• Lucro: R$ ${(fin.bancaAtual - fin.bancaInicial).toFixed(2)}\n• Crescimento: ${((fin.bancaAtual/fin.bancaInicial-1)*100).toFixed(2)}%`;

    enviarTelegram(msg, false);
}, 300000);

// --- ROTA STATUS (LIMPA O UNDEFINED) ---
app.get('/status', (req, res) => {
    let totalWins = stats.winDireto + stats.winG1 + stats.winG2;
    res.json({
        global: { 
            winDireto: stats.winDireto, 
            winGales: (stats.winG1 + stats.winG2), 
            loss: stats.loss, 
            precisao: stats.totalAnalises > 0 ? ((totalWins / stats.totalAnalises) * 100).toFixed(1) : "0.0",
            banca: fin.bancaAtual.toFixed(2), 
            lucro: (fin.bancaAtual - fin.bancaInicial).toFixed(2) 
        },
        ativos: Object.keys(motores).map(id => ({ 
            cardId: id, 
            nome: motores[id].nome, 
            preco: motores[id].preco, 
            forca: motores[id].forca, 
            status: motores[id].status 
        }))
    });
});

app.post('/mudar', (req, res) => { iniciarMotor(req.body.cardId, req.body.ativoId, req.body.nomeAtivo); res.json({ success: true }); });
app.listen(PORT, () => console.log(`Super Central ON`));
