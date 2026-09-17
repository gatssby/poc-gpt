// ==UserScript==
// @name         Anki NID Batcher - POC
// @namespace    leonardo-anki-batcher
// @version      1.0.0
// @description  Classifica automaticamente lotes de NIDs via GPT Anki, valida, salva checkpoints e exporta os resultados.
// @match        https://chatgpt.com/g/g-69c594348e90819195e6f81f08a9f89e-anki*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @run-at       document-idle
// ==/UserScript==

(async function () {
    'use strict';

    const GPT_HOME = 'https://chatgpt.com/g/g-69c594348e90819195e6f81f08a9f89e-anki';
    const BATCH_SIZE = 40;
    const STABLE_MS = 10000;
    const RESPONSE_TIMEOUT_MS = 15 * 60 * 1000;
    const INTER_BATCH_DELAY_MS = 5000;
    const RETRY_DELAY_MS = 10000;
    const MAX_ATTEMPTS = 3;

    const ALLOWED_DECKS = new Set([
        '#UFPR::Biologia::• Histologia Animal',
        '#UFPR::Biologia::• Histologia Animal::• Tecido Conjuntivo',
        '#UFPR::Biologia::• Histologia Animal::• Tecido Epitelial',
        '#UFPR::Biologia::• Histologia Animal::• Tecido Muscular',
        '#UFPR::Biologia::• Histologia Animal::• Tecido Nervoso',
        '#UFPR::Biologia::• Fisiologia Animal',
        '#UFPR::Biologia::• Fisiologia Animal::• Sistema Circulatório',
        '#UFPR::Biologia::• Fisiologia Animal::• Sistema Digestório',
        '#UFPR::Biologia::• Fisiologia Animal::• Sistema Endócrino',
        '#UFPR::Biologia::• Fisiologia Animal::• Sistema Excretor',
        '#UFPR::Biologia::• Fisiologia Animal::• Sistema Nervoso',
        '#UFPR::Biologia::• Fisiologia Animal::• Sistema Reprodutor',
        '#UFPR::Biologia::• Fisiologia Animal::• Sistema Reprodutor::• Ciclo Menstrual',
        '#UFPR::Biologia::• Fisiologia Animal::• Sistema Reprodutor::• Gametogênese',
        '#UFPR::Biologia::• Fisiologia Animal::• Sistema Respiratório',
        '#UFPR::Biologia::• Fisiologia Animal::• Sistema Imunológico',
        '#UFPR::Biologia::• Embriologia',
        '#UFPR::Biologia::• Embriologia::• Anexos Embrionários',
        '#UFPR::Biologia::• Embriologia::• Desenvolvimento Embrionário',
        '#UFPR::Biologia::• Embriologia::• Tipos de Ovos e Clivagem'
    ]);

    let ui = null;
    let automationBusy = false;

    function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
    function padBatch(number) { return String(number).padStart(3, '0'); }
    function batchKey(number) { return `batch_${padBatch(number)}`; }
    function batchRawKey(number) { return `${batchKey(number)}_raw`; }
    function batchUrlKey(number) { return `${batchKey(number)}_url`; }
    function batchMetaKey(number) { return `${batchKey(number)}_meta`; }
    function attemptsKey(number) { return `attempts_${padBatch(number)}`; }
    function failedKey(number, attempt) { return `failed_batch_${padBatch(number)}_attempt_${attempt}`; }
    function totalBatches(nids) { return Math.ceil(nids.length / BATCH_SIZE); }
    function getBatchNids(nids, batchNumber) {
        const start = (batchNumber - 1) * BATCH_SIZE;
        return nids.slice(start, start + BATCH_SIZE);
    }
    function isGptHome() { return location.href.replace(/\/+$/, '') === GPT_HOME; }
    function isConversationUrl() { return /\/c\/[^/?#]+/.test(location.pathname); }

    function parseNids(text) {
        const nids = text.split(/[,\s]+/).map(x => x.trim()).filter(Boolean);
        if (!nids.length) throw new Error('Nenhum NID encontrado.');
        const invalid = nids.filter(x => !/^\d+$/.test(x));
        if (invalid.length) throw new Error(`NIDs inválidos: ${invalid.slice(0, 10).join(',')}`);
        if (new Set(nids).size !== nids.length) throw new Error('Existem NIDs duplicados.');
        return nids;
    }

    function buildPrompt(nids) {
        const count = nids.length;
        return `Classifique independentemente os ${count} NIDs abaixo pelo conteúdo real de cada note.

NIDs:
${nids.join(',')}

DESTINOS PERMITIDOS:
${[...ALLOWED_DECKS].join('\n')}

REGRAS:
- analise o conteúdo real de cada note;
- ignore o deck atual como evidência semântica;
- escolha sempre o subdeck mais específico possível;
- evite os decks-raiz • Histologia Animal, • Fisiologia Animal e • Embriologia;
- use um deck-raiz somente quando o conteúdo realmente abranger múltiplos subtemas/sistemas e nenhum subdeck específico for adequado;
- para Image Occlusion, analise a imagem e o contexto visual;
- preserve notes claramente pertencentes à mesma família visual no mesmo destino;
- se houver dúvida real, use NEEDS_REVIEW em vez de forçar;
- cada NID fornecido deve aparecer exatamente uma vez;
- não inclua NIDs que não estejam na entrada;
- não mova nem altere nenhum card.

FORMATO DE SAÍDA OBRIGATÓRIO:

Retorne SOMENTE JSON válido.
Não use Markdown.
Não use blocos \`\`\`json.
Não escreva introdução, conclusão ou comentários fora do JSON.

Estrutura:

{
  "results": [
    {
      "nid": "123",
      "status": "CLASSIFIED",
      "deck": "#UFPR::Biologia::• Fisiologia Animal::• Sistema Nervoso",
      "reason": null
    },
    {
      "nid": "456",
      "status": "NEEDS_REVIEW",
      "deck": null,
      "reason": "motivo curto"
    }
  ]
}

REQUISITOS:
- "results" deve conter exatamente ${count} objetos;
- preserve todos os NIDs como strings;
- cada NID deve aparecer exatamente uma vez;
- status permitido: "CLASSIFIED" ou "NEEDS_REVIEW";
- para CLASSIFIED, "deck" deve corresponder exatamente a um dos destinos permitidos e "reason" deve ser null;
- para NEEDS_REVIEW, "deck" deve ser null e "reason" deve conter uma justificativa curta;
- não crie outros campos.`;
    }

    function defaultState() {
        return { running: false, pauseRequested: false, nextBatch: 1, activeBatch: null, activePhase: null, startedAt: null, lastError: null };
    }
    async function getState() {
        const stored = await GM_getValue('automation_state', null);
        return { ...defaultState(), ...(stored && typeof stored === 'object' ? stored : {}) };
    }
    async function saveState(state) { await GM_setValue('automation_state', state); }
    async function setState(patch) {
        const next = { ...(await getState()), ...patch };
        await saveState(next);
        return next;
    }

    function isVisible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return el.offsetParent !== null && rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) !== 0;
    }

    async function findComposer(timeoutMs = 60000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const el = document.querySelector('#prompt-textarea') || document.querySelector('div[contenteditable="true"]');
            if (el && isVisible(el)) return el;
            await sleep(500);
        }
        throw new Error('Composer não encontrado.');
    }

    async function fillComposer(text) {
        const el = await findComposer();
        el.focus();
        if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
            const setter = Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set;
            if (setter) setter.call(el, text); else el.value = text;
        } else {
            el.innerHTML = '';
            el.textContent = text;
        }
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(1000);
        return el;
    }

    async function sendMessage() {
        for (let i = 0; i < 40; i++) {
            const button = document.querySelector('button[data-testid="send-button"]');
            if (button && !button.disabled && isVisible(button)) { button.click(); return; }
            await sleep(500);
        }
        throw new Error('Botão Enviar não encontrado/ativado.');
    }

    function assistantMessages() { return [...document.querySelectorAll('[data-message-author-role="assistant"]')]; }
    function userMessages() { return [...document.querySelectorAll('[data-message-author-role="user"]')]; }

    function isGenerating() {
        return [...document.querySelectorAll('button')].some(button => {
            if (!isVisible(button)) return false;
            const testid = button.getAttribute('data-testid') || '';
            const aria = (button.getAttribute('aria-label') || '').trim();
            const title = (button.getAttribute('title') || '').trim();
            return testid === 'stop-button' || /^stop\b/i.test(aria) || /^parar\b/i.test(aria) || /^stop\b/i.test(title) || /^parar\b/i.test(title);
        });
    }

    async function waitForResponse(previousCount, onStatus = () => {}) {
        const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
        onStatus('Aguardando a resposta começar...');
        while (Date.now() < deadline) {
            if (assistantMessages().length > previousCount) break;
            await sleep(500);
        }
        if (assistantMessages().length <= previousCount) throw new Error('Nenhuma nova resposta do assistant foi detectada.');
        onStatus('Resposta iniciada. Aguardando terminar...');
        let previousText = '';
        let stableSince = null;
        while (Date.now() < deadline) {
            const messages = assistantMessages();
            if (messages.length <= previousCount) { await sleep(500); continue; }
            const text = messages[messages.length - 1]?.innerText?.trim() || '';
            const generating = isGenerating();
            if (text && text === previousText && !generating) {
                if (stableSince === null) { stableSince = Date.now(); onStatus('Resposta aparentemente concluída. Confirmando estabilidade...'); }
                const stableFor = Date.now() - stableSince;
                const remaining = Math.max(0, Math.ceil((STABLE_MS - stableFor) / 1000));
                if (stableFor >= STABLE_MS) return text;
                onStatus(`Confirmando fim da resposta... ${remaining}s`);
            } else {
                if (generating) onStatus('Resposta em geração...'); else if (text) onStatus('Resposta recebida; aguardando estabilizar...');
                previousText = text;
                stableSince = null;
            }
            await sleep(1000);
        }
        throw new Error('Timeout esperando a resposta terminar.');
    }

    function extractJson(text) {
        let cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start === -1 || end === -1 || end <= start) throw new Error('Nenhum objeto JSON encontrado.');
        return JSON.parse(cleaned.slice(start, end + 1));
    }

    function validate(data, expectedNids) {
        if (!data || typeof data !== 'object' || !Array.isArray(data.results)) throw new Error('Campo "results" inexistente ou inválido.');
        const topLevelKeys = Object.keys(data);
        if (topLevelKeys.length !== 1 || topLevelKeys[0] !== 'results') throw new Error('O JSON deve conter somente o campo "results" no nível superior.');
        if (data.results.length !== expectedNids.length) throw new Error(`Esperados ${expectedNids.length} resultados; recebidos ${data.results.length}.`);
        const expected = new Set(expectedNids);
        const found = new Set();
        for (const item of data.results) {
            if (!item || typeof item !== 'object') throw new Error('Resultado inválido na lista.');
            const keys = Object.keys(item).sort();
            if (JSON.stringify(keys) !== JSON.stringify(['deck', 'nid', 'reason', 'status'])) throw new Error(`Campos inválidos no resultado ${item.nid ?? '(sem nid)'}. Esperado: nid,status,deck,reason.`);
            if (typeof item.nid !== 'string' || !/^\d+$/.test(item.nid)) throw new Error('Resultado com NID inválido.');
            if (!expected.has(item.nid)) throw new Error(`NID extra: ${item.nid}`);
            if (found.has(item.nid)) throw new Error(`NID duplicado: ${item.nid}`);
            found.add(item.nid);
            if (item.status === 'CLASSIFIED') {
                if (!ALLOWED_DECKS.has(item.deck)) throw new Error(`Deck inválido para ${item.nid}: ${item.deck}`);
                if (item.reason !== null) throw new Error(`reason deveria ser null em ${item.nid}`);
            } else if (item.status === 'NEEDS_REVIEW') {
                if (item.deck !== null) throw new Error(`deck deveria ser null em ${item.nid}`);
                if (typeof item.reason !== 'string' || !item.reason.trim()) throw new Error(`reason ausente em ${item.nid}`);
            } else throw new Error(`Status inválido em ${item.nid}: ${item.status}`);
        }
        const missing = expectedNids.filter(x => !found.has(x));
        if (missing.length) throw new Error(`NIDs ausentes: ${missing.join(',')}`);
        return true;
    }

    async function reconcileProgress(nids) {
        const total = totalBatches(nids);
        let completed = 0;
        for (let batchNumber = 1; batchNumber <= total; batchNumber++) {
            const saved = await GM_getValue(batchKey(batchNumber), null);
            if (!saved) break;
            try { validate(saved, getBatchNids(nids, batchNumber)); completed = batchNumber; }
            catch (error) { console.warn(`[Anki NID Batcher] Checkpoint inválido no lote ${batchNumber}:`, error); break; }
        }
        return { completed, nextBatch: completed + 1, total, processedNids: Math.min(completed * BATCH_SIZE, nids.length) };
    }

    function setLog(text) {
        if (ui?.log) ui.log.textContent = text;
        console.log(`[Anki NID Batcher] ${text}`);
    }

    async function refreshPanel() {
        if (!ui) return;
        const nids = await GM_getValue('nids', []);
        const state = await getState();
        if (!nids.length) {
            ui.status.textContent = 'Nenhuma lista carregada.';
            ui.progress.textContent = 'Carregue lista_nids.txt.';
            ui.start.disabled = true; ui.pause.disabled = true; ui.exportJson.disabled = true; ui.exportCsv.disabled = true;
            return;
        }
        const progress = await reconcileProgress(nids);
        const processed = progress.completed === progress.total ? nids.length : progress.completed * BATCH_SIZE;
        ui.status.textContent = `${nids.length} NIDs armazenados.`;
        ui.progress.textContent = `Concluídos: ${progress.completed}/${progress.total} lotes • ${processed}/${nids.length} NIDs`;
        ui.start.disabled = state.running || progress.completed >= progress.total;
        ui.start.textContent = progress.completed ? 'Continuar processamento' : 'Iniciar processamento';
        ui.pause.disabled = !state.running || state.pauseRequested;
        ui.pause.textContent = state.pauseRequested ? 'Pausa solicitada' : 'Pausar após lote atual';
        ui.exportJson.disabled = progress.completed === 0;
        ui.exportCsv.disabled = progress.completed === 0;
        if (progress.completed >= progress.total) ui.state.textContent = 'Estado: CONCLUÍDO';
        else if (state.running && state.activeBatch) ui.state.textContent = `Estado: rodando lote ${state.activeBatch}/${progress.total}`;
        else if (state.running) ui.state.textContent = `Estado: preparando lote ${progress.nextBatch}/${progress.total}`;
        else if (state.lastError) ui.state.textContent = 'Estado: PARADO POR ERRO';
        else ui.state.textContent = 'Estado: pausado/pronto';
    }

    async function countdown(ms, label) {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            setLog(`${label} ${Math.ceil((end - Date.now()) / 1000)}s`);
            await sleep(Math.min(1000, Math.max(100, end - Date.now())));
            const state = await getState();
            if (!state.running || state.pauseRequested) return false;
        }
        return true;
    }

    async function saveSuccessfulBatch(batchNumber, batchNids, data, raw, attempt) {
        validate(data, batchNids);
        const classified = data.results.filter(x => x.status === 'CLASSIFIED').length;
        const review = data.results.length - classified;
        await GM_setValue(batchKey(batchNumber), data);
        await GM_setValue(batchRawKey(batchNumber), raw);
        await GM_setValue(batchUrlKey(batchNumber), location.href);
        await GM_setValue(batchMetaKey(batchNumber), { batch: batchNumber, count: batchNids.length, attempt, classified, needs_review: review, conversation_url: location.href, completed_at: new Date().toISOString() });
        let state = await getState();
        state = { ...state, nextBatch: batchNumber + 1, activeBatch: null, activePhase: null, lastError: null };
        if (state.pauseRequested) { state.running = false; state.pauseRequested = false; }
        await saveState(state);
        setLog(`Lote ${batchNumber} validado e salvo.\n${data.results.length}/${batchNids.length} NIDs válidos.\nCLASSIFIED: ${classified} • NEEDS_REVIEW: ${review}`);
        await refreshPanel();
        return state;
    }

    async function handleBatchFailure(batchNumber, attempt, error, raw = null) {
        const payload = { batch: batchNumber, attempt, error: error?.message || String(error), conversation_url: location.href, failed_at: new Date().toISOString(), raw_response: raw };
        await GM_setValue(failedKey(batchNumber, attempt), payload);
        let state = await getState();
        state = { ...state, activeBatch: null, activePhase: null, nextBatch: batchNumber, lastError: payload.error };
        const canRetry = state.running && !state.pauseRequested && attempt < MAX_ATTEMPTS;
        if (!canRetry) { state.running = false; state.pauseRequested = false; }
        await saveState(state);
        await refreshPanel();
        if (!canRetry) {
            setLog(`ERRO no lote ${batchNumber}, tentativa ${attempt}/${MAX_ATTEMPTS}.\n${payload.error}\nAutomação parada. Clique em "Continuar processamento" para tentar novamente.`);
            return;
        }
        setLog(`ERRO no lote ${batchNumber}, tentativa ${attempt}/${MAX_ATTEMPTS}.\n${payload.error}\nNova tentativa será feita em uma conversa nova.`);
        const shouldContinue = await countdown(RETRY_DELAY_MS, `Retentando lote ${batchNumber} em`);
        if (shouldContinue) location.assign(GPT_HOME);
    }

    async function processBatch(nids, batchNumber) {
        const batchNids = getBatchNids(nids, batchNumber);
        if (!batchNids.length) throw new Error(`Lote ${batchNumber} está vazio.`);
        const previousAttempts = Number(await GM_getValue(attemptsKey(batchNumber), 0)) || 0;
        const attempt = previousAttempts + 1;
        if (attempt > MAX_ATTEMPTS) {
            await setState({ running: false, activeBatch: null, activePhase: null, lastError: `Lote ${batchNumber} já atingiu ${MAX_ATTEMPTS} tentativas automáticas.` });
            setLog(`Lote ${batchNumber} já atingiu ${MAX_ATTEMPTS} tentativas automáticas.\nUse "Continuar processamento" se quiser permitir uma nova rodada manual.`);
            await GM_setValue(attemptsKey(batchNumber), 0);
            await refreshPanel();
            return;
        }
        await GM_setValue(attemptsKey(batchNumber), attempt);
        let state = await getState();
        state = { ...state, activeBatch: batchNumber, activePhase: 'preparing', nextBatch: batchNumber, lastError: null };
        await saveState(state);
        await refreshPanel();
        let raw = null;
        try {
            setLog(`Lote ${batchNumber}/${totalBatches(nids)} • ${batchNids.length} NIDs • tentativa ${attempt}/${MAX_ATTEMPTS}\nPreenchendo prompt...`);
            const before = assistantMessages().length;
            await fillComposer(buildPrompt(batchNids));
            state = await getState();
            if (!state.running || state.pauseRequested) {
                state.running = false; state.pauseRequested = false; state.activeBatch = null; state.activePhase = null;
                await saveState(state); setLog('Pausado antes do envio do lote.'); await refreshPanel(); return;
            }
            setLog(`Lote ${batchNumber}/${totalBatches(nids)} • enviando ${batchNids.length} NIDs...`);
            await sendMessage();
            await setState({ activeBatch: batchNumber, activePhase: 'waiting' });
            raw = await waitForResponse(before, message => setLog(`Lote ${batchNumber}/${totalBatches(nids)}\n${message}`));
            setLog(`Lote ${batchNumber}: resposta concluída. Validando JSON...`);
            const data = extractJson(raw);
            state = await saveSuccessfulBatch(batchNumber, batchNids, data, raw, attempt);
            await GM_setValue(attemptsKey(batchNumber), 0);
            const progress = await reconcileProgress(nids);
            if (progress.completed >= progress.total) {
                await setState({ running: false, pauseRequested: false, activeBatch: null, activePhase: null, nextBatch: progress.total + 1, lastError: null });
                const summary = await buildSummary(nids);
                setLog(`PROCESSAMENTO CONCLUÍDO.\n${summary.completedBatches}/${summary.totalBatches} lotes • ${summary.totalResults}/${nids.length} NIDs\nCLASSIFIED: ${summary.classified}\nNEEDS_REVIEW: ${summary.needsReview}\nUse Exportar JSON/CSV para baixar os resultados.`);
                await refreshPanel(); return;
            }
            if (!state.running) {
                setLog(`Lote ${batchNumber} salvo. Automação pausada com segurança.\nPróximo lote: ${progress.nextBatch}/${progress.total}.`);
                await refreshPanel(); return;
            }
            const shouldContinue = await countdown(INTER_BATCH_DELAY_MS, `Lote ${batchNumber} salvo. Abrindo conversa nova em`);
            if (shouldContinue) location.assign(GPT_HOME);
        } catch (error) {
            console.error('[Anki NID Batcher] Erro no lote:', error);
            await handleBatchFailure(batchNumber, attempt, error, raw);
        }
    }

    async function recoverActiveBatch(nids, state) {
        const batchNumber = Number(state.activeBatch);
        const batchNids = getBatchNids(nids, batchNumber);
        const attempt = Math.max(1, Number(await GM_getValue(attemptsKey(batchNumber), 1)) || 1);
        if (!batchNids.length) {
            await setState({ running: false, activeBatch: null, activePhase: null, lastError: `Lote ativo inválido: ${batchNumber}` });
            setLog(`Lote ativo inválido: ${batchNumber}.`); return;
        }
        if (state.activePhase === 'waiting' && isConversationUrl() && userMessages().length > 0) {
            let raw = null;
            try {
                setLog(`Recuperando lote ${batchNumber}/${totalBatches(nids)} após recarga...`);
                raw = await waitForResponse(0, message => setLog(`Recuperando lote ${batchNumber}\n${message}`));
                const data = extractJson(raw);
                const nextState = await saveSuccessfulBatch(batchNumber, batchNids, data, raw, attempt);
                await GM_setValue(attemptsKey(batchNumber), 0);
                const progress = await reconcileProgress(nids);
                if (progress.completed >= progress.total) {
                    await setState({ running: false, pauseRequested: false });
                    const summary = await buildSummary(nids);
                    setLog(`PROCESSAMENTO CONCLUÍDO.\n${summary.totalResults}/${nids.length} NIDs validados.`);
                    await refreshPanel(); return;
                }
                if (!nextState.running) { setLog(`Lote ${batchNumber} recuperado e salvo. Automação pausada.`); await refreshPanel(); return; }
                const shouldContinue = await countdown(INTER_BATCH_DELAY_MS, `Lote ${batchNumber} recuperado. Abrindo conversa nova em`);
                if (shouldContinue) location.assign(GPT_HOME);
                return;
            } catch (error) { await handleBatchFailure(batchNumber, attempt, error, raw); return; }
        }
        await setState({ activeBatch: null, activePhase: null, nextBatch: batchNumber });
        setLog(`Estado intermediário do lote ${batchNumber} recuperado.\nReabrindo em uma conversa nova para evitar duplicação.`);
        await sleep(1500);
        location.assign(GPT_HOME);
    }

    async function runAutomation() {
        if (automationBusy) return;
        automationBusy = true;
        try {
            const nids = await GM_getValue('nids', []);
            if (!nids.length) { setLog('Carregue lista_nids.txt antes de iniciar.'); await setState({ running: false }); await refreshPanel(); return; }
            let state = await getState();
            let progress = await reconcileProgress(nids);
            if (!state.activeBatch) { state.nextBatch = progress.nextBatch; await saveState(state); }
            if (progress.completed >= progress.total) {
                await setState({ running: false, pauseRequested: false, activeBatch: null, activePhase: null, nextBatch: progress.total + 1, lastError: null });
                setLog('Todos os lotes já estão concluídos.'); await refreshPanel(); return;
            }
            state = await getState();
            if (!state.running) { await refreshPanel(); return; }
            if (state.pauseRequested && !state.activeBatch) {
                await setState({ running: false, pauseRequested: false }); setLog('Automação pausada.'); await refreshPanel(); return;
            }
            if (state.activeBatch) { await recoverActiveBatch(nids, state); return; }
            progress = await reconcileProgress(nids);
            const batchNumber = progress.nextBatch;
            if (!isGptHome()) {
                setLog(`Preparando lote ${batchNumber}/${progress.total}.\nAbrindo uma conversa nova...`);
                location.assign(GPT_HOME); return;
            }
            await processBatch(nids, batchNumber);
        } catch (error) {
            console.error('[Anki NID Batcher] Falha geral:', error);
            await setState({ running: false, activeBatch: null, activePhase: null, lastError: error?.message || String(error) });
            setLog(`ERRO GERAL:\n${error?.message || String(error)}\nAutomação parada sem avançar o checkpoint.`);
            await refreshPanel();
        } finally { automationBusy = false; }
    }

    async function buildSummary(nids) {
        const progress = await reconcileProgress(nids);
        let classified = 0, needsReview = 0, totalResults = 0;
        for (let batchNumber = 1; batchNumber <= progress.completed; batchNumber++) {
            const data = await GM_getValue(batchKey(batchNumber), null);
            if (!data?.results) continue;
            for (const item of data.results) { totalResults++; if (item.status === 'CLASSIFIED') classified++; else if (item.status === 'NEEDS_REVIEW') needsReview++; }
        }
        return { completedBatches: progress.completed, totalBatches: progress.total, totalResults, classified, needsReview };
    }

    async function collectExport(nids) {
        const progress = await reconcileProgress(nids);
        const batches = [], results = [];
        for (let batchNumber = 1; batchNumber <= progress.completed; batchNumber++) {
            const data = await GM_getValue(batchKey(batchNumber), null);
            const meta = await GM_getValue(batchMetaKey(batchNumber), null);
            const url = meta?.conversation_url || await GM_getValue(batchUrlKey(batchNumber), null);
            if (!data?.results) continue;
            batches.push({ batch: batchNumber, count: data.results.length, conversation_url: url || null, attempt: meta?.attempt ?? null, completed_at: meta?.completed_at ?? null });
            for (const item of data.results) results.push({ batch: batchNumber, nid: item.nid, status: item.status, deck: item.deck, reason: item.reason, conversation_url: url || null });
        }
        return { generated_at: new Date().toISOString(), source_nids_count: nids.length, batch_size: BATCH_SIZE, total_batches: totalBatches(nids), completed_batches: progress.completed, batches, results };
    }

    function downloadText(filename, text, mime) {
        const blob = new Blob([text], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    function csvEscape(value) { if (value === null || value === undefined) return ''; return `"${String(value).replace(/"/g, '""')}"`; }

    async function exportJson() {
        const nids = await GM_getValue('nids', []); if (!nids.length) return;
        const payload = await collectExport(nids);
        downloadText('anki_nid_classifications.json', JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
        setLog(`JSON exportado com ${payload.results.length} resultados.`);
    }
    async function exportCsv() {
        const nids = await GM_getValue('nids', []); if (!nids.length) return;
        const payload = await collectExport(nids);
        const header = ['batch', 'nid', 'status', 'deck', 'reason', 'conversation_url'];
        const rows = payload.results.map(item => [item.batch, item.nid, item.status, item.deck, item.reason, item.conversation_url]);
        const csv = [header.map(csvEscape).join(','), ...rows.map(row => row.map(csvEscape).join(','))].join('\n');
        downloadText('anki_nid_classifications.csv', '\uFEFF' + csv, 'text/csv;charset=utf-8');
        setLog(`CSV exportado com ${payload.results.length} resultados.`);
    }

    async function resetProgressWithoutConfirm(nids) {
        const total = nids.length ? totalBatches(nids) : 100;
        for (let batchNumber = 1; batchNumber <= total; batchNumber++) {
            await GM_deleteValue(batchKey(batchNumber)); await GM_deleteValue(batchRawKey(batchNumber)); await GM_deleteValue(batchUrlKey(batchNumber)); await GM_deleteValue(batchMetaKey(batchNumber)); await GM_deleteValue(attemptsKey(batchNumber));
            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) await GM_deleteValue(failedKey(batchNumber, attempt));
        }
        await GM_deleteValue('automation_state');
    }

    async function resetProgress() {
        const nids = await GM_getValue('nids', []);
        if (!window.confirm('Apagar TODOS os checkpoints, respostas e progresso desta execução?\n\nA lista de NIDs será preservada.')) return;
        await setState({ running: false, pauseRequested: false });
        await resetProgressWithoutConfirm(nids);
        setLog('Progresso apagado. A lista de NIDs foi preservada.');
        await refreshPanel();
    }

    function createPanel() {
        if (document.querySelector('#anki-nid-batcher-panel')) return document.querySelector('#anki-nid-batcher-panel');
        const panel = document.createElement('div'); panel.id = 'anki-nid-batcher-panel';
        panel.style.cssText = 'position:fixed;top:70px;right:18px;z-index:999999;width:340px;padding:14px;background:#111;color:#fff;border:1px solid #555;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.35);font:13px -apple-system,BlinkMacSystemFont,sans-serif';
        panel.innerHTML = `
            <div style="display:flex;justify-content:space-between;gap:10px;align-items:center"><strong>Anki NID Batcher — v1.0</strong><span style="opacity:.65;font-size:11px">definitiva</span></div>
            <div id="nid-status" style="margin-top:10px">Nenhuma lista carregada.</div>
            <div id="nid-progress" style="margin-top:4px;opacity:.8">—</div>
            <div id="nid-state" style="margin-top:4px;opacity:.8">Estado: —</div>
            <input id="nid-file" type="file" accept=".txt,text/plain" style="width:100%;margin:12px 0 8px">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
                <button id="nid-start" style="padding:8px;cursor:pointer">Iniciar processamento</button>
                <button id="nid-pause" style="padding:8px;cursor:pointer">Pausar após lote atual</button>
                <button id="nid-export-json" style="padding:7px;cursor:pointer">Exportar JSON</button>
                <button id="nid-export-csv" style="padding:7px;cursor:pointer">Exportar CSV</button>
            </div>
            <button id="nid-reset" style="width:100%;margin-top:6px;padding:6px;cursor:pointer;opacity:.75">Resetar progresso</button>
            <div id="nid-log" style="margin-top:10px;padding-top:9px;border-top:1px solid #333;white-space:pre-wrap;font-size:12px;line-height:1.35;max-height:180px;overflow:auto"></div>`;
        document.body.appendChild(panel); return panel;
    }

    async function handleFileUpload(file) {
        const incoming = parseNids(await file.text());
        const current = await GM_getValue('nids', []);
        const progress = current.length ? await reconcileProgress(current) : { completed: 0 };
        const sameList = current.length === incoming.length && current.every((nid, index) => nid === incoming[index]);
        if (!sameList && progress.completed > 0) {
            const confirmed = window.confirm(`Já existem ${progress.completed} lotes salvos para a lista atual.\n\nCarregar uma lista diferente exige apagar o progresso salvo. Continuar?`);
            if (!confirmed) return;
            await resetProgressWithoutConfirm(current);
        }
        await GM_setValue('nids', incoming);
        const existing = await reconcileProgress(incoming);
        await setState({ running: false, pauseRequested: false, nextBatch: existing.nextBatch, activeBatch: null, activePhase: null, lastError: null });
        setLog(`${incoming.length} NIDs carregados.\n${totalBatches(incoming)} lotes no total.`);
        await refreshPanel();
    }

    async function wirePanel() {
        const panel = createPanel();
        ui = { panel, status: panel.querySelector('#nid-status'), progress: panel.querySelector('#nid-progress'), state: panel.querySelector('#nid-state'), file: panel.querySelector('#nid-file'), start: panel.querySelector('#nid-start'), pause: panel.querySelector('#nid-pause'), exportJson: panel.querySelector('#nid-export-json'), exportCsv: panel.querySelector('#nid-export-csv'), reset: panel.querySelector('#nid-reset'), log: panel.querySelector('#nid-log') };
        ui.file.addEventListener('change', async event => {
            try { const file = event.target.files?.[0]; if (file) await handleFileUpload(file); }
            catch (error) { console.error(error); setLog(`ERRO AO CARREGAR LISTA:\n${error.message}`); }
            finally { ui.file.value = ''; }
        });
        ui.start.addEventListener('click', async () => {
            const nids = await GM_getValue('nids', []);
            if (!nids.length) { setLog('Carregue lista_nids.txt primeiro.'); return; }
            const progress = await reconcileProgress(nids);
            if (progress.completed >= progress.total) { setLog('Todos os lotes já estão concluídos.'); await refreshPanel(); return; }
            await GM_setValue(attemptsKey(progress.nextBatch), 0);
            await setState({ running: true, pauseRequested: false, nextBatch: progress.nextBatch, activeBatch: null, activePhase: null, startedAt: new Date().toISOString(), lastError: null });
            setLog(`Automação iniciada/retomada.\nPróximo lote: ${progress.nextBatch}/${progress.total}.`);
            await refreshPanel();
            if (!isGptHome()) location.assign(GPT_HOME); else await runAutomation();
        });
        ui.pause.addEventListener('click', async () => {
            const state = await getState();
            if (!state.running) { setLog('A automação já está pausada.'); return; }
            if (state.activeBatch) {
                await setState({ pauseRequested: true });
                setLog(`Pausa solicitada.\nO lote ${state.activeBatch} será concluído e salvo antes de parar.`);
            } else {
                await setState({ running: false, pauseRequested: false }); setLog('Automação pausada.');
            }
            await refreshPanel();
        });
        ui.exportJson.addEventListener('click', exportJson);
        ui.exportCsv.addEventListener('click', exportCsv);
        ui.reset.addEventListener('click', resetProgress);
        await refreshPanel();
    }

    while (!document.body) await sleep(100);
    await wirePanel();
    const nids = await GM_getValue('nids', []);
    if (nids.length) {
        const progress = await reconcileProgress(nids);
        let state = await getState();
        if (!state.activeBatch) { state.nextBatch = progress.nextBatch; await saveState(state); }
        if (progress.completed > 0 && !state.running) setLog(`${progress.completed}/${progress.total} lotes já validados em storage.\nPróximo lote: ${progress.completed < progress.total ? progress.nextBatch : 'nenhum — concluído'}.`);
        if (state.running) { await sleep(1200); await runAutomation(); }
    }
})();
