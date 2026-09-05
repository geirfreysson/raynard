/**
 * The modal behind a bookmark @-mention's collapsed "reading …" chip in a user
 * bubble: shows the bookmark's full Q&A exactly as it was spliced into the
 * sent message. Mirrors citation-modal.ts's create-once/reuse pattern and
 * reuses its modal chrome classes (`.citation-modal-*`), since this is the
 * same interaction on different content.
 */

let modal: HTMLElement | null = null;

export function openBookmarkReferenceModal(title: string, prompt: string, answer: string) {
  const host = ensureModal();
  const titleEl = host.querySelector<HTMLElement>('.citation-modal-title');
  const body = host.querySelector<HTMLElement>('.citation-modal-body');
  if (!titleEl || !body) return;

  titleEl.textContent = title;
  body.textContent = '';

  const question = document.createElement('p');
  question.className = 'citation-modal-quote';
  question.textContent = prompt;
  body.appendChild(question);

  const response = document.createElement('p');
  response.className = 'citation-modal-quote';
  response.textContent = answer;
  body.appendChild(response);

  host.classList.remove('is-hidden');
  host.setAttribute('aria-hidden', 'false');
  host.querySelector<HTMLButtonElement>('.citation-modal-close')?.focus();
}

export function closeBookmarkReferenceModal() {
  if (!modal) return;
  modal.classList.add('is-hidden');
  modal.setAttribute('aria-hidden', 'true');
}

function ensureModal(): HTMLElement {
  if (modal) return modal;

  const host = document.createElement('section');
  host.className = 'citation-modal-overlay is-hidden';
  host.setAttribute('aria-hidden', 'true');
  host.innerHTML = `
    <div class="citation-modal" role="dialog" aria-modal="true" aria-labelledby="bookmarkRefModalTitle">
      <header class="citation-modal-header">
        <div>
          <h2 id="bookmarkRefModalTitle" class="citation-modal-title"></h2>
        </div>
        <button class="citation-modal-close" type="button" aria-label="Close referenced bookmark">x</button>
      </header>
      <div class="citation-modal-body"></div>
    </div>
  `;

  host.addEventListener('click', (event) => {
    if (event.target === host) closeBookmarkReferenceModal();
  });
  host
    .querySelector('.citation-modal-close')
    ?.addEventListener('click', closeBookmarkReferenceModal);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeBookmarkReferenceModal();
  });

  document.body.appendChild(host);
  modal = host;
  return host;
}

/** Test seam: drops the cached modal so each case starts from a clean DOM. */
export function resetBookmarkReferenceModal() {
  modal?.remove();
  modal = null;
}
