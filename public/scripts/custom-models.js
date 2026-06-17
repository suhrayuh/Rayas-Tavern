// @ts-nocheck
import { saveSettingsDebounced } from '../script.js';
import { extension_settings } from './extensions.js';
import { POPUP_RESULT, POPUP_TYPE, callGenericPopup } from './popup.js';

const CUSTOM_MODELS_SETTINGS_KEY = 'customModels';

function ensureSettings() {
    if (!extension_settings[CUSTOM_MODELS_SETTINGS_KEY]) {
        extension_settings[CUSTOM_MODELS_SETTINGS_KEY] = { provider: {} };
    }

    const settings = extension_settings[CUSTOM_MODELS_SETTINGS_KEY];
    if (!settings.provider || typeof settings.provider !== 'object') {
        settings.provider = {};
    }

    return settings;
}

function getProviderModels(settings, provider) {
    if (!Array.isArray(settings.provider[provider])) {
        settings.provider[provider] = [];
    }

    return settings.provider[provider];
}

/**
 * Injects custom models UI into a provider model select element.
 * @param {HTMLSelectElement} selectElement The model select element
 * @param {string} provider Provider name extracted from select id
 */
function injectCustomModelsForSelect(selectElement, provider) {
    const settings = ensureSettings();
    const models = getProviderModels(settings, provider);

    const parent = selectElement.parentElement;
    if (!parent) {
        return;
    }

    // Create button
    const btn = document.createElement('div');
    btn.classList.add('stcm--btn', 'menu_button', 'fa-solid', 'fa-fw', 'fa-pen-to-square');
    btn.title = 'Edit custom models';

    // Create optgroup
    const optgroup = document.createElement('optgroup');
    optgroup.label = 'Custom Models';

    function populateOptGroup() {
        optgroup.innerHTML = '';
        for (const model of models) {
            const option = document.createElement('option');
            option.value = model;
            option.textContent = model;
            optgroup.append(option);
        }
    }

    function restoreSelectedModel() {
        const selectedModel = settings[`${provider}_model`];
        if (selectedModel && models.includes(selectedModel)) {
            selectElement.value = selectedModel;
            selectElement.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    // Button click handler - open edit popup
    btn.addEventListener('click', async () => {
        const dom = document.createElement('div');
        const header = document.createElement('h3');
        header.textContent = `Custom Models: ${provider}`;
        dom.append(header);
        const hint = document.createElement('small');
        hint.textContent = 'One model name per line';
        dom.append(hint);
        const textarea = document.createElement('textarea');
        textarea.classList.add('text_pole');
        textarea.rows = 20;
        textarea.value = models.join('\n');
        dom.append(textarea);

        const result = await callGenericPopup(dom, POPUP_TYPE.TEXT, null, { okButton: 'Save' });
        if (result === POPUP_RESULT.AFFIRMATIVE) {
            models.length = 0;
            models.push(...textarea.value.split('\n').filter(line => line.trim().length > 0));
            saveSettingsDebounced();
            populateOptGroup();
            restoreSelectedModel();
        }
    });

    // Build wrapper: <div class="flex-container flexNoGap"><select flex1/><div marginLeft5><btn/></div></div>
    // This matches the Manage API Keys button placement style
    const wrapper = document.createElement('div');
    wrapper.classList.add('flex-container', 'flexNoGap');
    wrapper.style.alignItems = 'flex-start';

    const btnContainer = document.createElement('div');
    btnContainer.classList.add('flex-container', 'marginLeft5', 'gap3px');
    btnContainer.append(btn);

    // Move select into wrapper as flex1
    parent.insertBefore(wrapper, selectElement);
    selectElement.classList.add('flex1');
    wrapper.append(selectElement);
    wrapper.append(btnContainer);

    // Populate optgroup
    populateOptGroup();
    selectElement.insertBefore(optgroup, selectElement.children[0]);

    // Restore previously saved custom model selection
    restoreSelectedModel();

    // Track custom model selection
    selectElement.addEventListener('change', () => {
        const currentSelected = selectElement.value;
        const previousSaved = settings[`${provider}_model`];
        if (currentSelected !== previousSaved) {
            // Only persist if the selected value is one of our custom models
            if (models.includes(currentSelected)) {
                settings[`${provider}_model`] = currentSelected;
            } else {
                delete settings[`${provider}_model`];
            }
            saveSettingsDebounced();
        }
    });
}

/**
 * Initializes the custom models feature.
 * Auto-discovers all provider model selects and injects custom model support.
 */
export function initCustomModels() {
    const settings = ensureSettings();
    const selectElements = document.querySelectorAll('select[id^="model_"][id$="_select"]');

    for (const select of selectElements) {
        const id = select.id;
        // Skip the freeform custom model input (it's a datalist, not relevant)
        if (id === 'model_custom_select') {
            continue;
        }

        // Extract provider name: model_{provider}_select → {provider}
        const match = id.match(/^model_(.+)_select$/);
        if (!match) {
            continue;
        }

        const provider = match[1];
        const models = getProviderModels(settings, provider);
        injectCustomModelsForSelect(select, provider);
    }
}
