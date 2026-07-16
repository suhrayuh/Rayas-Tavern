import { t } from './i18n.js';
import { callGenericPopup, Popup, POPUP_TYPE } from './popup.js';
import { timestampToMoment } from './utils.js';
import { characters, getCurrentChatId, getRequestHeaders, reloadCurrentChat, this_chid } from '/script.js';
import { selected_group } from './group-chats.js';

class BackupsBrowser {
    /** @type {HTMLElement} */
    #buttonElement;
    /** @type {HTMLElement} */
    #buttonChevronIcon;
    /** @type {HTMLElement} */
    #backupsListElement;
    /** @type {AbortController} */
    #loadingAbortController;
    /** @type {boolean} */
    #isOpen = false;
    /** @type {number} */
    #currentPage = 0;
    /** @type {boolean} */
    #showAllChats = false;

    get isOpen() {
        return this.#isOpen;
    }

    /**
     * View a backup file content.
     * @param {number} backupId Backup database ID.
     * @returns {Promise<void>}
     */
    async viewBackup(backupId) {
        const response = await fetch('/api/backups/chat/download', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ backup_id: backupId }),
        });

        if (!response.ok) {
            toastr.error(t`Failed to download backup, try again later.`);
            console.error('Failed to download chat backup:', response.statusText);
            return;
        }

        try {
            /** @type {ChatMessage[]} */
            const parsedLines = [];
            const fileText = await response.text();
            fileText.split('\n').forEach(line => {
                try {
                    /** @type {ChatMessage} */
                    const lineData = JSON.parse(line);
                    if (lineData?.mes) {
                        parsedLines.push(lineData);
                    }
                } catch (error) {
                    console.error('Failed to parse chat backup line:', error);
                }
            });
            const textArea = document.createElement('textarea');
            textArea.classList.add('text_pole', 'monospace', 'textarea_compact', 'margin0', 'height100p');
            textArea.readOnly = true;
            textArea.value = parsedLines.map(l => `${l.name} [${timestampToMoment(l.send_date).format('lll')}]\n${l.mes}`).join('\n\n\n');
            await callGenericPopup(textArea, POPUP_TYPE.TEXT, '', { allowVerticalScrolling: true, large: true, wide: true });
        } catch (error) {
            console.error('Failed to parse chat backup content:', error);
            toastr.error(t`Failed to parse backup content.`);
            return;
        }
    }

    /**
     * Restore a backup in place.
     * @param {number} backupId Backup database ID.
     * @param {string} chatId Chat ID restored by this backup.
     * @returns {Promise<void>}
     */
    async restoreBackup(backupId, chatId) {
        const confirm = await Popup.show.confirm(t`Restore this chat backup?`, t`The current version will be preserved as a recovery snapshot first.`);
        if (!confirm) {
            return;
        }

        const response = await fetch('/api/backups/chat/restore', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ backup_id: backupId }),
        });

        if (!response.ok) {
            toastr.error(t`Failed to restore backup, try again later.`);
            console.error('Failed to restore chat backup:', response.statusText);
            return;
        }
        toastr.success(t`Chat backup restored.`);
        const activeChatId = selected_group
            ? `group/${getCurrentChatId()}`
            : `char/${String(characters[this_chid]?.avatar ?? '').replace('.png', '')}/${getCurrentChatId()}`;
        if (activeChatId === chatId) {
            await reloadCurrentChat();
        }
    }

    /**
     * Delete a backup file.
     * @param {number} backupId Backup database ID.
     * @returns {Promise<boolean>} True if deleted, false otherwise.
     */
    async deleteBackup(backupId) {
        const confirm = await Popup.show.confirm(t`Are you sure?`);
        if (!confirm) {
            return false;
        }

        const response = await fetch('/api/backups/chat/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ backup_id: backupId }),
        });

        if (!response.ok) {
            toastr.error(t`Failed to delete backup, try again later.`);
            console.error('Failed to delete chat backup:', response.statusText);
            return false;
        }

        toastr.success(t`Backup deleted successfully.`);
        return true;
    }

/**
     * Load backups and populate the list element.
     * @param {AbortSignal} signal Signal to abort loading.
     * @returns {Promise<void>}
     */
    async loadBackupsIntoList(signal) {
        if (!this.#backupsListElement) {
            return;
        }

        this.#backupsListElement.innerHTML = '';

        const requestBody = {
            page: this.#currentPage,
            per_page: 5,
        };
        if (!this.#showAllChats) {
            const currentChatId = this.#getCurrentChatId();
            if (currentChatId) {
                requestBody.chat_id = currentChatId;
            }
        }

        let response;
        try {
            response = await fetch('/api/backups/chat/get', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(requestBody),
                signal,
            });
        } catch (error) {
            if (error?.name === 'AbortError') {
                return;
            }
            console.error('Failed to load chat backups list:', error);
            return;
        }

        if (!response.ok) {
            console.error('Failed to load chat backups list:', response.statusText);
            return;
        }

        const result = await response.json();
        const backupsList = result?.items || [];

        for (const backup of backupsList) {
            const listItem = document.createElement('div');
            listItem.classList.add('chatBackupsListItem');

            const backupName = document.createElement('div');
            backupName.textContent = backup.file_name;
            backupName.classList.add('chatBackupsListItemName');

            const backupInfo = document.createElement('div');
            backupInfo.classList.add('chatBackupsListItemInfo');
            backupInfo.textContent = `${timestampToMoment(backup.created_at).format('lll')} · ${backup.backup_type} (${backup.file_size}, ${backup.chat_items} 💬)`;

            const actionsList = document.createElement('div');
            actionsList.classList.add('chatBackupsListItemActions');

            const viewButton = document.createElement('div');
            viewButton.classList.add('right_menu_button', 'fa-solid', 'fa-eye');
            viewButton.title = t`View backup`;
            viewButton.addEventListener('click', async () => {
                await this.viewBackup(backup.backup_id);
            });

            const restoreButton = document.createElement('div');
            restoreButton.classList.add('right_menu_button', 'fa-solid', 'fa-rotate-left');
            restoreButton.title = t`Restore backup`;
            restoreButton.addEventListener('click', async () => {
                await this.restoreBackup(backup.backup_id, backup.chat_id);
            });

            const deleteButton = document.createElement('div');
            deleteButton.classList.add('right_menu_button', 'fa-solid', 'fa-trash');
            deleteButton.title = t`Delete backup`;
            deleteButton.addEventListener('click', async () => {
                const isDeleted = await this.deleteBackup(backup.backup_id);
                if (isDeleted) {
                    listItem.remove();
                }
            });

            actionsList.appendChild(viewButton);
            actionsList.appendChild(restoreButton);
            actionsList.appendChild(deleteButton);

            listItem.appendChild(backupName);
            listItem.appendChild(backupInfo);
            listItem.appendChild(actionsList);

            this.#backupsListElement.appendChild(listItem);
        }

        const pagination = document.createElement('div');
        pagination.classList.add('chatBackupsListPagination');

        const toggleButton = document.createElement('a');
        toggleButton.classList.add('chatBackupsListToggle');
        toggleButton.textContent = this.#showAllChats ? t`Show this chat only` : t`Show all chats`;
        toggleButton.addEventListener('click', () => {
            this.#showAllChats = !this.#showAllChats;
            this.#currentPage = 0;
            this.#refresh();
        });
        pagination.appendChild(toggleButton);

        const totalPages = Math.ceil(result.total / result.per_page) || 1;
        if (totalPages > 1) {
            const info = document.createElement('span');
            info.textContent = `${result.total} backups · page ${result.page + 1} / ${totalPages}`;
            pagination.appendChild(info);

            if (result.page > 0) {
                const prevBtn = document.createElement('a');
                prevBtn.classList.add('chatBackupsListPage');
                prevBtn.textContent = '←';
                prevBtn.addEventListener('click', () => {
                    this.#currentPage--;
                    this.#refresh();
                });
                pagination.appendChild(prevBtn);
            }

            if (result.page < totalPages - 1) {
                const nextBtn = document.createElement('a');
                nextBtn.classList.add('chatBackupsListPage');
                nextBtn.textContent = '→';
                nextBtn.addEventListener('click', () => {
                    this.#currentPage++;
                    this.#refresh();
                });
                pagination.appendChild(nextBtn);
            }
        } else {
            const info = document.createElement('span');
            info.textContent = `${result.total} backups`;
            pagination.appendChild(info);
        }

        this.#backupsListElement.appendChild(pagination);
    }

    /**
     * Get the full chat ID for the currently active chat.
     * @returns {string|null}
     */
    #getCurrentChatId() {
        if (selected_group) {
            const id = getCurrentChatId();
            return id ? `group/${id}` : null;
        }
        if (this_chid !== undefined && characters[this_chid]) {
            const avatar = String(characters[this_chid].avatar ?? '').replace('.png', '');
            const id = getCurrentChatId();
            return id ? `char/${avatar}/${id}` : null;
        }
        return null;
    }

    /**
     * Reload the current view, aborting any in-flight request.
     */
    #refresh() {
        if (this.#loadingAbortController) {
            this.#loadingAbortController.abort();
            this.#loadingAbortController = null;
        }
        if (!this.#isOpen) {
            return;
        }
        this.#loadingAbortController = new AbortController();
        this.loadBackupsIntoList(this.#loadingAbortController.signal).catch(() => {});
    }

    closeBackups() {
        if (!this.#isOpen) {
            return;
        }

        this.#isOpen = false;
        if (this.#buttonChevronIcon) {
            this.#buttonChevronIcon.classList.remove('fa-chevron-up');
            this.#buttonChevronIcon.classList.add('fa-chevron-down');
        }
        if (this.#backupsListElement) {
            this.#backupsListElement.classList.remove('open');
            this.#backupsListElement.innerHTML = '';
        }
        if (this.#loadingAbortController) {
            this.#loadingAbortController.abort();
            this.#loadingAbortController = null;
        }
    }

    openBackups() {
        if (this.#isOpen) {
            return;
        }

        this.#isOpen = true;
        this.#currentPage = 0;
        if (this.#buttonChevronIcon) {
            this.#buttonChevronIcon.classList.remove('fa-chevron-down');
            this.#buttonChevronIcon.classList.add('fa-chevron-up');
        }
        if (this.#backupsListElement) {
            this.#backupsListElement.classList.add('open');
        }

        this.#loadingAbortController = new AbortController();
        this.loadBackupsIntoList(this.#loadingAbortController.signal).catch(() => {});
    }

    renderButton() {
        if (this.#buttonElement) {
            return;
        }

        const sibling = document.getElementById('select_chat_search');
        if (!sibling) {
            console.error('Could not find sibling element for BackupsBrowser button');
            return;
        }

        const button = document.createElement('button');
        button.classList.add('menu_button', 'menu_button_icon');

        const buttonIcon = document.createElement('i');
        buttonIcon.classList.add('fa-solid', 'fa-box-open');

        const buttonText = document.createElement('span');
        buttonText.textContent = t`Backups`;
        buttonText.title = t`Browse chat backups`;

        const chevronIcon = document.createElement('i');
        chevronIcon.classList.add('fa-solid', 'fa-chevron-down', 'fa-sm');

        button.appendChild(buttonIcon);
        button.appendChild(buttonText);
        button.appendChild(chevronIcon);

        button.addEventListener('click', () => {
            if (this.#isOpen) {
                this.closeBackups();
            } else {
                this.openBackups();
            }
        });

        sibling.parentNode.insertBefore(button, sibling);

        this.#buttonElement = button;
        this.#buttonChevronIcon = chevronIcon;
    }

    renderBackupsList() {
        if (this.#backupsListElement) {
            return;
        }

        const sibling = document.getElementById('select_chat_div');
        if (!sibling) {
            console.error('Could not find sibling element for BackupsBrowser list');
            return;
        }

        const list = document.createElement('div');
        list.classList.add('chatBackupsList');

        sibling.parentNode.insertBefore(list, sibling);
        this.#backupsListElement = list;
    }
}

const backupsBrowser = new BackupsBrowser();

export function addChatBackupsBrowser() {
    backupsBrowser.renderButton();
    backupsBrowser.renderBackupsList();

    // Refresh the backups list if it's already open
    if (backupsBrowser.isOpen) {
        backupsBrowser.closeBackups();
        backupsBrowser.openBackups();
    }
}
