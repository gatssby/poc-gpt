// ==UserScript==
// @name         Anki NID Batcher - POC
// @namespace    leonardo-anki-batcher
// @version      0.2.0
// @description  Classifica lotes de NIDs via GPT Anki, valida JSON e salva o resultado localmente.
// @match        https://chatgpt.com/g/g-69c594348e90819195e6f81f08a9f89e-anki*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @run-at       document-idle
// ==/UserScript==

(async function () {
    'use strict';

    const BATCH_SIZE = 40;
    const STABLE_MS = 10000;
    const RESPONSE_TIMEOUT_MS = 15 * 60 * 1000;

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

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function parseNids(text) {
        const nids = text
            .split(/[,\s]+/)
            .map(x => x.trim())
            .filter(Boolean);

        if (!nids.length) {
            throw new Error('Nenhum NID encontrado.');
        }

        const invalid = nids.filter(x => !/^\d+$/.test(x));

        if (invalid.length) {
            throw new Error(`NIDs inválidos: ${invalid.slice(0, 10).join(',')}`);
        }

        if (new Set(nids).size !== nids.length) {
            throw new Error('Existem NIDs duplicados.');
        }

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

    async function findComposer() {
        const deadline = Date.now() + 60000;

        while (Date.now() < deadline) {
            const el =
                document.querySelector('#prompt-textarea') ||
                document.querySelector('div[contenteditable="true"]');

            if (el && el.offsetParent !== null) {
                return el;
            }

            await sleep(500);
        }

        throw new Error('Composer não encontrado.');
    }

    async function fillComposer(text) {
        const el = await findComposer();
        el.focus();

        if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
            const setter = Object.getOwnPropertyDescriptor(
                el instanceof HTMLTextAreaElement
                    ? HTMLTextAreaElement.prototype
                    : HTMLInputElement.prototype,
                'value'
            )?.set;

            if (setter) setter.call(el, text);
            else el.value = text;
        } else {
            // ChatGPT normalmente usa um contenteditable/ProseMirror.
            el.innerHTML = '';
            el.textContent = text;
        }

        el.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            inputType: 'insertText',
            data: text
        }));

        el.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(1000);

        return el;
    }

    async function sendMessage() {
        for (let i = 0; i < 40; i++) {
            const button = document.querySelector('button[data-testid="send-button"]');

            if (button && !button.disabled && button.offsetParent !== null) {
                button.click();
                return;
            }

            await sleep(500);
        }

        throw new Error('Botão Enviar não encontrado/ativado.');
    }

    function assistantMessages() {
        return [
            ...document.querySelectorAll('[data-message-author-role="assistant"]')
        ];
    }

    function isVisible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);

        return (
            el.offsetParent !== null &&
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            Number(style.opacity || 1) !== 0
        );
    }

    function isGenerating() {
        const buttons = [...document.querySelectorAll('button')];

        return buttons.some(button => {
            if (!isVisible(button)) return false;

            const testid = button.getAttribute('data-testid') || '';
            const aria = (button.getAttribute('aria-label') || '').trim();
            const title = (button.getAttribute('title') || '').trim();

            return (
                testid === 'stop-button' ||
                /^stop\b/i.test(aria) ||
                /^parar\b/i.test(aria) ||
                /^stop\b/i.test(title) ||
                /^parar\b/i.test(title)
            );
        });
    }

    async function waitForResponse(previousCount, onStatus = () => {}) {
        const deadline = Date.now() + RESPONSE_TIMEOUT_MS;

        onStatus('Aguardando a resposta começar...');

        while (Date.now() < deadline) {
            if (assistantMessages().length > previousCount) {
                break;
            }

            await sleep(500);
        }

        if (assistantMessages().length <= previousCount) {
            throw new Error('Nenhuma nova resposta do assistant foi detectada.');
        }

        onStatus('Resposta iniciada. Aguardando terminar...');

        let previousText = '';
        let stableSince = null;

        while (Date.now() < deadline) {
            const messages = assistantMessages();

            if (messages.length <= previousCount) {
                await sleep(500);
                continue;
            }

            const last = messages[messages.length - 1];
            const text = last?.innerText?.trim() || '';
            const generating = isGenerating();

            if (text && text === previousText && !generating) {
                if (stableSince === null) {
                    stableSince = Date.now();
                    onStatus('Resposta aparentemente concluída. Confirmando estabilidade...');
                }

                const stableFor = Date.now() - stableSince;
                const remaining = Math.max(0, Math.ceil((STABLE_MS - stableFor) / 1000));

                if (stableFor >= STABLE_MS) {
                    return text;
                }

                onStatus(`Confirmando fim da resposta... ${remaining}s`);
            } else {
                if (generating) {
                    onStatus('Resposta em geração...');
                } else if (text) {
                    onStatus('Resposta recebida; aguardando estabilizar...');
                }

                previousText = text;
                stableSince = null;
            }

            await sleep(1000);
        }

        throw new Error('Timeout esperando a resposta terminar.');
    }

    function extractJson(text) {
        let cleaned = text.trim();

        cleaned = cleaned
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/i, '');

        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');

        if (start === -1 || end === -1 || end <= start) {
            throw new Error('Nenhum objeto JSON encontrado.');
        }

        return JSON.parse(cleaned.slice(start, end + 1));
    }

    function validate(data, expectedNids) {
        if (!data || typeof data !== 'object' || !Array.isArray(data.results)) {
            throw new Error('Campo "results" inexistente ou inválido.');
        }

        const topLevelKeys = Object.keys(data);
        if (topLevelKeys.length !== 1 || topLevelKeys[0] !== 'results') {
            throw new Error('O JSON deve conter somente o campo "results" no nível superior.');
        }

        if (data.results.length !== expectedNids.length) {
            throw new Error(
                `Esperados ${expectedNids.length} resultados; recebidos ${data.results.length}.`
            );
        }

        const expected = new Set(expectedNids);
        const found = new Set();

        for (const item of data.results) {
            if (!item || typeof item !== 'object') {
                throw new Error('Resultado inválido na lista.');
            }

            const keys = Object.keys(item).sort();
            const expectedKeys = ['deck', 'nid', 'reason', 'status'];

            if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
                throw new Error(
                    `Campos inválidos no resultado ${item.nid ?? '(sem nid)'}. ` +
                    `Esperado: nid,status,deck,reason.`
                );
            }

            if (typeof item.nid !== 'string' || !/^\d+$/.test(item.nid)) {
                throw new Error('Resultado com NID inválido.');
            }

            if (!expected.has(item.nid)) {
                throw new Error(`NID extra: ${item.nid}`);
            }

            if (found.has(item.nid)) {
                throw new Error(`NID duplicado: ${item.nid}`);
            }

            found.add(item.nid);

            if (item.status === 'CLASSIFIED') {
                if (!ALLOWED_DECKS.has(item.deck)) {
                    throw new Error(`Deck inválido para ${item.nid}: ${item.deck}`);
                }

                if (item.reason !== null) {
                    throw new Error(`reason deveria ser null em ${item.nid}`);
                }
            } else if (item.status === 'NEEDS_REVIEW') {
                if (item.deck !== null) {
                    throw new Error(`deck deveria ser null em ${item.nid}`);
                }

                if (typeof item.reason !== 'string' || !item.reason.trim()) {
                    throw new Error(`reason ausente em ${item.nid}`);
                }
            } else {
                throw new Error(`Status inválido em ${item.nid}: ${item.status}`);
            }
        }

        const missing = expectedNids.filter(x => !found.has(x));

        if (missing.length) {
            throw new Error(`NIDs ausentes: ${missing.join(',')}`);
        }

        return true;
    }

    function createPanel() {
        if (document.querySelector('#anki-nid-batcher-panel')) {
            return document.querySelector('#anki-nid-batcher-panel');
        }

        const panel = document.createElement('div');
        panel.id = 'anki-nid-batcher-panel';

        panel.style.cssText = `
            position: fixed;
            top: 80px;
            right: 20px;
            z-index: 999999;
            width: 320px;
            padding: 14px;
            background: #111;
            color: #fff;
            border: 1px solid #555;
            border-radius: 10px;
            box-shadow: 0 8px 30px rgba(0,0,0,.35);
            font: 13px -apple-system, BlinkMacSystemFont, sans-serif;
        `;

        panel.innerHTML = `
            <strong>Anki NID Batcher — POC v0.2</strong>

            <div id="nid-status" style="margin:10px 0">
                Nenhuma lista carregada.
            </div>

            <input
                id="nid-file"
                type="file"
                accept=".txt,text/plain"
                style="width:100%;margin-bottom:8px"
            >

            <button
                id="nid-test"
                style="width:100%;padding:8px;cursor:pointer"
            >
                Testar primeiro lote
            </button>

            <div
                id="nid-log"
                style="
                    margin-top:10px;
                    white-space:pre-wrap;
                    font-size:12px;
                    line-height:1.35;
                "
            ></div>
        `;

        document.body.appendChild(panel);
        return panel;
    }

    // Aguarda o body existir em navegações SPA mais lentas.
    while (!document.body) {
        await sleep(100);
    }

    const panel = createPanel();
    const status = panel.querySelector('#nid-status');
    const log = panel.querySelector('#nid-log');
    const input = panel.querySelector('#nid-file');
    const test = panel.querySelector('#nid-test');

    const setLog = text => {
        log.textContent = text;
    };

    const stored = await GM_getValue('nids', []);

    if (Array.isArray(stored) && stored.length) {
        status.textContent = `${stored.length} NIDs armazenados.`;
        setLog(`Lotes: ${Math.ceil(stored.length / BATCH_SIZE)}`);
    }

    input.addEventListener('change', async event => {
        try {
            const file = event.target.files?.[0];
            if (!file) return;

            const text = await file.text();
            const nids = parseNids(text);

            await GM_setValue('nids', nids);

            status.textContent = `${nids.length} NIDs carregados.`;
            setLog(`Lotes: ${Math.ceil(nids.length / BATCH_SIZE)}`);
        } catch (err) {
            console.error(err);
            setLog(`ERRO: ${err.message}`);
        }
    });

    test.addEventListener('click', async () => {
        test.disabled = true;

        try {
            const nids = await GM_getValue('nids', []);

            if (!Array.isArray(nids) || !nids.length) {
                throw new Error('Carregue lista_nids.txt primeiro.');
            }

            const batch = nids.slice(0, BATCH_SIZE);

            setLog(`Preparando ${batch.length} NIDs...`);

            const before = assistantMessages().length;

            await fillComposer(buildPrompt(batch));

            setLog('Enviando primeiro lote...');
            await sendMessage();

            const raw = await waitForResponse(before, setLog);

            setLog('Resposta concluída. Validando JSON...');

            const data = extractJson(raw);
            validate(data, batch);

            await GM_setValue('batch_001', data);
            await GM_setValue('batch_001_raw', raw);
            await GM_setValue('batch_001_url', location.href);

            const classified = data.results.filter(x => x.status === 'CLASSIFIED').length;
            const review = data.results.filter(x => x.status === 'NEEDS_REVIEW').length;

            setLog(
                `OK.\n` +
                `${data.results.length}/${batch.length} NIDs validados.\n` +
                `CLASSIFIED: ${classified}\n` +
                `NEEDS_REVIEW: ${review}\n` +
                `Resposta salva no Tampermonkey.`
            );
        } catch (err) {
            console.error(err);
            setLog(`ERRO:\n${err.message}`);
        } finally {
            test.disabled = false;
        }
    });
})();