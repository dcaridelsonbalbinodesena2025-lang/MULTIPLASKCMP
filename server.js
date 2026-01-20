2const WebSocket = require('ws');
const fetch = require('node-fetch');
const express = require('express');
const cors = require('cors');
const cron = require('node-cron'); // Ajustado para 'cron'

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000; 

// --- CONFIGURAÇÕES ---
const TG_TOKEN = "8427077212:AAEiL_3_D_-fukuaR95V3FqoYYyHvdCHmEI"; 
const TG_CHAT_ID = "-1003355965894"; 
const LINK_CORRETORA = "https://track.deriv.com/_S_W1N_"; 

// --- GESTÃO FINANCEIRA (SIMULADOR) ---
let fin = {
    bancaInicial: 5000,
    bancaAtual: 5000,
    payout: 0.95,
    lucroHoje: 0
};

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

// Inicializa motores vazios
for(let i=1; i<=6; i++) {
    motores[`card${i}`] = { nome: "OFF", status: "DESATIVADO", preco: "---", forca: 50 };
}

// --- RESET DIÁRIO (00:00) ---
// CORREÇÃO: Usando cron.schedule conforme a biblioteca node-cron exige
cron.schedule('0 0 * * *', () => {
    fin.bancaAtual = fin.bancaInicial;
    fin.lucroHoje = 0;
    enviarTelegram("📅 *SIMULADOR DIÁRIO RESETADO*\nA banca voltou ao valor inicial configurado.", false);
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

// ROTA PARA O INDEX CONFIGURAR BANCA E PAYOUT
app.post('/config-financeira', (req, res) => {
    const { banca, payout } = req.body;
    fin.bancaInicial = parseFloat(banca);
    fin.bancaAtual = parseFloat(banca);
    fin.payout = parseFloat(payout) / 100;
    fin.lucroHoje = 0;
    res.json({ success: true });
});

app.get('/status', (req, res) => {
    let winsD = Object.values(stats).reduce((a, b) => a + b.d, 0);
    let winsG = Object.values(stats).reduce((a, b) => a + (b.g1 + b.g2), 0);
    let lossT = Object.values(stats).reduce((a, b) => a + b.loss, 0);
    let totalA = Object.values(stats).reduce((a, b) => a + b.t, 0);
    let prec = totalA > 0 ? (((winsD + winsG) / totalA) * 100).toFixed(1) : "0.0";

    res.json({
        global: {
            winDireto: winsD,
            winGales: winsG,
            loss: lossT,
            precisao: prec,
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
        operacao: { ativa: false, estrategia: "", precoEntrada: 0, tempo: 0, direcao: "", gale: 0, valorInvestido: 0, valorRaiz: 0 }
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

            if (!m.operacao.ativa && (m.forca >= 80 || m.forca <= 20)) {
                m.sinalPendenteRegra1 = m.forca >= 80 ? "CALL" : "PUT";
                m.buscandoTaxaRegra1 = true;
                enviarTelegram(`🔍 *ALERTA: REGRA 1*\n📊 Ativo: ${m.nome}\n⚡ Direção: ${m.sinalPendenteRegra1 === "CALL" ? "COMPRA 🟢" : "VENDA 🔴"}\n⏰ Início previsto: ${getHoraBrasilia()}`, false);
            }
        }

        // --- ENTRADA REGRA 1 ---
        if (m.buscandoTaxaRegra1 && !m.operacao.ativa) {
            let diffVela = Math.abs(m.fechamentoAnterior - m.aberturaVela) || 0.0001;
            let confirmou = (m.sinalPendenteRegra1 === "CALL" && preco <= (m.aberturaVela - (diffVela * 0.2))) || 
                            (m.sinalPendenteRegra1 === "PUT" && preco >= (m.aberturaVela + (diffVela * 0.2)));
            if (confirmou) {
                let valorEntrada = fin.bancaAtual * 0.01; 
                fin.bancaAtual -= valorEntrada; 

                m.operacao = { 
                    ativa: true, estrategia: "REGRA 1", precoEntrada: preco, tempo: 60, 
                    direcao: m.sinalPendenteRegra1, gale: 0, 
                    valorInvestido: valorEntrada, valorRaiz: valorEntrada 
                };
                m.buscandoTaxaRegra1 = false;
                m.status = "OPERANDO REGRA 1";
                enviarTelegram(`🚀 *ENTRADA: REGRA 1*\n📊 Ativo: ${m.nome}\n⚡ Direção: ${m.operacao.direcao}\n💰 Valor: R$ ${valorEntrada.toFixed(2)}\n⏰ Início: ${getHoraBrasilia()}`);
            }
        }

        // --- ENTRADA SNIPER ---
        if (segs === 45 && !m.operacao.ativa) {
            let diffB = (preco - m.aberturaVela) / m.aberturaVela * 1000;
            if (Math.abs(diffB) > 0.7) {
                let dR = diffB > 0 ? "PUT" : "CALL";
                let valorEntrada = fin.bancaAtual * 0.01; 
                fin.bancaAtual -= valorEntrada; 

                m.operacao = { 
                    ativa: true, estrategia: "SNIPER (RETRAÇÃO)", precoEntrada: preco, tempo: 15, 
                    direcao: dR, gale: 0, 
                    valorInvestido: valorEntrada, valorRaiz: valorEntrada 
                };
                m.status = "OPERANDO SNIPER";
                enviarTelegram(`✅ *ENTRADA: SNIPER*\n📊 Ativo: ${m.nome}\n💰 Valor: R$ ${valorEntrada.toFixed(2)}\n⏰ Fim: ${getHoraBrasilia(new Date(agora.getTime()+15000))}`);
            }
        }

        // --- GERENCIADOR DE RESULTADOS E GALES ---
        if (m.operacao.ativa) {
            m.operacao.tempo--;
            if (m.operacao.tempo <= 0) {
                let win = (m.operacao.direcao === "CALL" && preco > m.operacao.precoEntrada) || (m.operacao.direcao === "PUT" && preco < m.operacao.precoEntrada);
                let e = m.operacao.estrategia;
                
                if (win) {
                    let lucro = m.operacao.valorInvestido * fin.payout;
                    fin.bancaAtual += (m.operacao.valorInvestido + lucro); 
                    
                    if (m.operacao.gale === 0) stats[e].d++; else if (m.operacao.gale === 1) stats[e].g1++; else stats[e].g2++;
                    stats[e].t++;
                    
                    enviarTelegram(`✅ *WIN: ${e}*\n🎯 Resultado: ${m.operacao.gale > 0 ? 'Gale '+m.operacao.gale : 'Direto'}\n💰 Lucro: R$ ${lucro.toFixed(2)}\n📊 PLACAR: ${getPlacarGeral()}`);
                    m.operacao.ativa = false; m.status = "MONITORANDO";
                } else if (m.operacao.gale < (e === "REGRA 1" ? 2 : 1)) {
                    m.operacao.gale++; 
                    let valorGale = m.operacao.valorInvestido * 2; 
                    fin.bancaAtual -= valorGale; 
                    
                    m.operacao.valorInvestido = valorGale;
                    m.operacao.tempo = 60; 
                    m.operacao.precoEntrada = preco;
                    m.status = `GALE ${m.operacao.gale} - ${e}`;
                    
                    enviarTelegram(`🔄 *GALE ${m.operacao.gale}: ${e}*\n📊 Ativo: ${m.nome}\n💰 Valor Gale: R$ ${valorGale.toFixed(2)}\n⏰ Início: ${getHoraBrasilia()}`);
                } else {
                    stats[e].loss++; stats[e].t++;
                    enviarTelegram(`❌ *LOSS: ${e}*\n📊 Ativo: ${m.nome}\n📊 PLACAR: ${getPlacarGeral()}`);
                    m.operacao.ativa = false; m.status = "MONITORANDO";
                }
            }
        }
    });
    motores[cardId] = m;
}

// RELATÓRIO DE RANKING E PERFORMANCE (A cada 5 min)
setInterval(() => {
    let ranking = Object.keys(stats).map(key => {
        let s = stats[key];
        let totalWins = s.d + s.g1 + s.g2;
        let efDireta = s.t > 0 ? ((s.d / s.t) * 100).toFixed(1) : "0.0";
        let assertividade = s.t > 0 ? ((totalWins / s.t) * 100).toFixed(1) : "0.0";
        return { nome: key, ...s, totalWins, efDireta, assertividade };
    }).sort((a, b) => b.assertividade - a.assertividade);

    let msg = `🏆 *RANKING DE PERFORMANCE*\n\n`;
    ranking.forEach((est, i) => {
        msg += `${i+1}º *${est.nome}*\n• Wins: D: ${est.d} | G1: ${est.g1} | G2: ${est.g2}\n• Efic. s/ Gale: ${est.efDireta}%\n• *ASSERTIVIDADE: ${est.assertividade}%*\n\n`;
    });
    
    let lucroS = (fin.bancaAtual - fin.bancaInicial).toFixed(2);
    msg += `💰 *FINANCEIRO:* R$ ${fin.bancaAtual.toFixed(2)}\n📈 *LUCRO:* R$ ${lucroS}\n📊 *TOTAL:* ${getPlacarGeral()}`;
    enviarTelegram(msg, false);
}, 300000);

app.post('/mudar', (req, res) => {
    const { cardId, ativoId, nomeAtivo } = req.body;
    iniciarMotor(cardId, ativoId, nomeAtivo);
    res.json({ success: true });
});
// COMANDO PARA RECEBER RELATÓRIO FORMATADO PARA PDF
app.post('/telegram-webhook', (req, res) => {
    const msg = req.body.message;
    if (msg && msg.text === '/pdf') {
        let lucroS = (fin.bancaAtual - fin.bancaInicial).toFixed(2);
        let winT = Object.values(stats).reduce((a, b) => a + (b.d + b.g1 + b.g2), 0);
        let lossT = Object.values(stats).reduce((a, b) => a + b.loss, 0);
        
        let relatorio = `📄 *RELATÓRIO OFICIAL DE PERFORMANCE*\n`;
        relatorio += `📅 Data: ${new Date().toLocaleDateString('pt-BR')}\n`;
        relatorio += `━━━━━━━━━━━━━━━━━━━━\n`;
        relatorio += `💰 *FINANCEIRO*\n`;
        relatorio += `• Banca Inicial: R$ ${fin.bancaInicial.toFixed(2)}\n`;
        relatorio += `• Banca Atual: R$ ${fin.bancaAtual.toFixed(2)}\n`;
        relatorio += `• Lucro/Prejuízo: R$ ${lucroS}\n`;
        relatorio += `━━━━━━━━━━━━━━━━━━━━\n`;
        relatorio += `📊 *PLACAR GERAL*: ${winT}W - ${lossT}L\n`;
        relatorio += `━━━━━━━━━━━━━━━━━━━━\n`;
        relatorio += `⚠️ _Para gerar o arquivo PDF, copie esta mensagem e use a função 'Imprimir > Salvar como PDF' do seu celular._`;

        enviarTelegram(relatorio, false);
    }
    res.sendStatus(200);
});

app.listen(PORT, () => console.log(`Super Central ON`));
