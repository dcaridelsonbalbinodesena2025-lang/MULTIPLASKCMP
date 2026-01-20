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

// Função de Horário do Brasil
function getHoraBrasilia(data = new Date()) {
    return data.toLocaleTimeString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

// Estatísticas com Suporte a Gale para o Relatório
let stats = {
    "FLUXO SNIPER": { winDireto: 0, winGale: 0, loss: 0, analises: 0 },
    "SNIPER (RETRAÇÃO)": { winDireto: 0, winGale: 0, loss: 0, analises: 0 },
    "ZIGZAG FRACTAL": { winDireto: 0, winGale: 0, loss: 0, analises: 0 }
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
            let calculoForca = 50 + (diff / (m.aberturaVela * 0.0002) * 20);
            m.forca = Math.min(98, Math.max(2, calculoForca));
        }

        if (segs === 0) {
            if (m.aberturaVela > 0) {
                m.historicoCores.push(preco > m.aberturaVela ? "VERDE" : "VERMELHA");
                if (m.historicoCores.length > 5) m.historicoCores.shift();
            }
            m.aberturaVela = preco;
            m.alertaEnviado = false;
        }

        // --- ALERTAS ANTECIPADOS COM NOME DA ESTRATÉGIA ---
        if (segs === 30 && !m.operacao.ativa && !m.alertaEnviado) {
            let p_estr = ""; let p_dir = "";
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
                let horaPrev = getHoraBrasilia(new Date(agora.getTime() + 30000)).slice(0, 5);
                enviarTelegram(`⚠️ *ALERTA DE POSSÍVEL ENTRADA*\n\n🧠 Estratégia: *${p_estr}*\n📊 Ativo: ${m.nome}\n⚡ Direção: ${p_dir}\n⏰ Horário previsto: ${horaPrev}\n\n_Fique atento para a confirmação!_`, false);
            }
        }

        // --- ENTRADA CONFIRMADA ---
        if (segs === 0 && !m.operacao.ativa) {
            let estr = ""; let dir = "";
            let ultimas3 = m.historicoCores.slice(-3);
            if (ultimas3.length === 3 && ultimas3.every(c => c === "VERDE")) { estr = "FLUXO SNIPER"; dir = "CALL"; }
            else if (ultimas3.length === 3 && ultimas3.every(c => c === "VERMELHA")) { estr = "FLUXO SNIPER"; dir = "PUT"; }
            if (!estr && m.historicoCores.length >= 2) {
                let p = m.historicoCores.slice(-2);
                if (p[0] === "VERDE" && p[1] === "VERMELHA") { estr = "ZIGZAG FRACTAL"; dir = "PUT"; }
                else if (p[0] === "VERMELHA" && p[1] === "VERDE") { estr = "ZIGZAG FRACTAL"; dir = "CALL"; }
            }

            if (estr) {
                m.operacao = { ativa: true, estrategia: estr, precoEntrada: preco, tempo: 60, direcao: dir, gale: 0 };
                enviarTelegram(`✅ *ENTRADA CONFIRMADA (CLIQUE AGORA 🟢)*\n\n🔥 Estratégia: *${estr}*\n💎 Ativo: ${m.nome}\n📈 Ação: ${dir === "CALL" ? "COMPRA 🟢" : "VENDA 🔴"}\n⏰ Início: ${getHoraBrasilia()}\n🏁 Fim: ${getHoraBrasilia(new Date(agora.getTime()+60000))}`);
            }
        }

        // --- SNIPER (45s) ---
        if (segs === 45 && !m.operacao.ativa) {
            let diffB = (preco - m.aberturaVela) / m.aberturaVela * 1000;
            if (Math.abs(diffB) > 0.7) {
                let dirB = diffB > 0 ? "PUT" : "CALL";
                let estrB = "SNIPER (RETRAÇÃO)";
                m.operacao = { ativa: true, estrategia: estrB, precoEntrada: preco, tempo: 15, direcao: dirB, gale: 0 };
                enviarTelegram(`✅ *ENTRADA CONFIRMADA (CLIQUE AGORA 🟢)*\n\n🎯 Estratégia: *${estrB}*\n💎 Ativo: ${m.nome}\n📈 Ação: ${dirB === "CALL" ? "COMPRA 🟢" : "VENDA 🔴"}\n⏰ Início: ${getHoraBrasilia()}\n🏁 Fim: ${getHoraBrasilia(new Date(agora.getTime()+15000))}`);
            }
        }

        // --- RESULTADO E GALE ---
        if (m.operacao.ativa) {
            m.operacao.tempo--;
            if (m.operacao.tempo <= 0) {
                let win = (m.operacao.direcao === "CALL" && preco > m.operacao.precoEntrada) || (m.operacao.direcao === "PUT" && preco < m.operacao.precoEntrada);
                let e = m.operacao.estrategia;

                if (win) {
                    if (m.operacao.gale === 0) stats[e].winDireto++; else stats[e].winGale++;
                    stats[e].analises++;
                    enviarTelegram(`✅ *RESULTADO: WIN ${m.operacao.gale > 0 ? 'GALE' : 'DIRETO'}*\n🧠 Estratégia: *${e}*\n🌍 Ativo: ${m.nome}\n🟢 Placar: ${stats[e].winDireto + stats[e].winGale}W | 🔴 ${stats[e].loss}L`);
                    m.operacao.ativa = false;
                } else if (m.operacao.gale < 1) { // 1 Gale de recuperação
                    m.operacao.gale++;
                    m.operacao.tempo = 60;
                    m.operacao.precoEntrada = preco;
                    enviarTelegram(`🔄 *RECUPERAÇÃO (GALE 1)*\n🧠 Estratégia: *${e}*\n💎 Ativo: ${m.nome}\n⏰ Fim: ${getHoraBrasilia(new Date(agora.getTime()+60000))}`);
                } else {
                    stats[e].loss++;
                    stats[e].analises++;
                    enviarTelegram(`❌ *RESULTADO: LOSS*\n🧠 Estratégia: *${e}*\n🌍 Ativo: ${m.nome}\n🟢 Placar: ${stats[e].winDireto + stats[e].winGale}W | 🔴 ${stats[e].loss}L`);
                    m.operacao.ativa = false;
                }
            }
        }
    });
    motores[cardId] = m;
}

// RELATÓRIO COM EFICIÊNCIA DUPLA
setInterval(() => {
    let msg = `📊 *RELATÓRIO DE PERFORMANCE*\n\n`;
    for (let e in stats) {
        let total = stats[e].analises;
        let efDireta = total > 0 ? ((stats[e].winDireto / total) * 100).toFixed(1) : "0.0";
        let efComGale = total > 0 ? (((stats[e].winDireto + stats[e].winGale) / total) * 100).toFixed(1) : "0.0";
        msg += `🧠 *${e}*:\n• Placar: ${stats[e].winDireto+stats[e].winGale}W - ${stats[e].loss}L\n• Efic. Direta: ${efDireta}%\n• Efic. Final (Gale): ${efComGale}%\n\n`;
    }
    enviarTelegram(msg, false);
}, 300000);

// ROTAS API
app.get('/status', (req, res) => {
    let ativosStatus = Object.keys(motores).map(id => ({
        cardId: id, nome: motores[id].nome, preco: motores[id].preco,
        status: motores[id].operacao?.ativa ? "OPERANDO..." : (motores[id].nome === "OFF" ? "DESATIVADO" : "ANALISANDO..."),
        forca: motores[id].forca || 50
    }));
    res.json({ global: { winDireto: 0, loss: 0, precisao: 0 }, ativos: ativosStatus });
});

app.post('/mudar', (req, res) => {
    const { cardId, ativoId, nomeAtivo } = req.body;
    iniciarMotor(cardId, ativoId, nomeAtivo);
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`Multi-Server ON` ));
