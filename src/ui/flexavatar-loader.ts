import { Button, Container, Label, TextInput } from '@playcanvas/pcui';

import { Events } from '../events';

// In-app "Load FlexAvatar" dialog: lists the bake folders under /bakes and adds the chosen one to
// the CURRENT scene (no page reload), so a composition can be built up interactively. Discovery and
// the actual load go through events (`flexAvatar.listBakes`, `flexAvatar.load`) registered where the
// Scene is available (scene-manifest.ts). A manual path field covers bakes served elsewhere.
class FlexAvatarLoaderDialog extends Container {
    show: () => void;
    hide: () => void;

    constructor(events: Events, args = {}) {
        super({
            ...args,
            id: 'flexavatar-loader',
            class: 'settings-dialog',
            hidden: true,
            tabIndex: -1
        });

        const dialog = new Container({ id: 'dialog' });

        const headerText = new Label({ id: 'text', text: 'LOAD FLEXAVATAR' });
        const header = new Container({ id: 'header' });
        header.append(headerText);

        const info = new Label({ class: 'label', text: 'Bakes in /bakes — click one to add it to the scene:' });
        info.style.width = '100%';
        info.style.whiteSpace = 'normal';
        const infoRow = new Container({ class: 'row' });
        infoRow.append(info);

        // discovered bake list (raw DOM children so it's cheap to rebuild)
        const list = new Container({ id: 'flexload-list' });

        // manual path fallback
        const pathInput = new TextInput({ class: 'flexload-path', placeholder: './bakes/NAME/' });
        const pathLoad = new Button({ class: 'button', text: 'Load path' });
        const pathRow = new Container({ class: 'row' });
        pathRow.append(pathInput);
        pathRow.append(pathLoad);

        const content = new Container({ id: 'content' });
        content.append(infoRow);
        content.append(list);
        content.append(pathRow);

        const refreshButton = new Button({ class: 'button', text: 'Refresh' });
        const closeButton = new Button({ class: 'button', text: 'Close' });
        const footer = new Container({ id: 'footer' });
        footer.append(refreshButton);
        footer.append(closeButton);

        dialog.append(header);
        dialog.append(content);
        dialog.append(footer);
        this.append(dialog);

        const loadBase = async (base: string) => {
            this.hidden = true;
            await events.invoke('flexAvatar.load', base);
        };

        const populate = async () => {
            list.dom.innerHTML = '<div class="flexload-note">Scanning /bakes…</div>';
            let names: string[] = [];
            try {
                names = (await events.invoke('flexAvatar.listBakes')) ?? [];
            } catch (e) {
                names = [];
            }
            list.dom.innerHTML = '';
            if (names.length === 0) {
                list.dom.innerHTML = '<div class="flexload-note">No bakes found — use the path field below.</div>';
                return;
            }
            for (const name of names) {
                const item = document.createElement('button');
                item.className = 'flexload-item';
                item.textContent = name;
                item.addEventListener('click', () => loadBase(`./bakes/${name}/`));
                list.dom.appendChild(item);
            }
        };

        refreshButton.on('click', () => populate());
        closeButton.on('click', () => {
            this.hidden = true;
        });
        pathLoad.on('click', () => {
            const v = (pathInput.value || '').trim();
            if (v) loadBase(v.endsWith('/') ? v : `${v}/`);
        });

        // click-outside / Escape to close
        this.dom.addEventListener('click', (e: MouseEvent) => {
            if (e.target === this.dom) this.hidden = true;
        });
        this.dom.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Escape') this.hidden = true;
        });

        this.show = () => {
            this.hidden = false;
            this.dom.focus();
            populate();
        };
        this.hide = () => {
            this.hidden = true;
        };
    }
}

export { FlexAvatarLoaderDialog };
