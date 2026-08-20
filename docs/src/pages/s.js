import React, {useEffect, useState} from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Head from '@docusaurus/Head';
import Layout from '@theme/Layout';

import shareConfig from '../../../share.config.json';
import {decodeSharePayload, degradationLine, teaserLine} from '../lib/share-link';
import {downloadUrlForUserAgent} from '../lib/download';
import styles from './s.module.css';

// The landing page for a shared answer.
//
// The payload lives in the URL fragment, so it never reaches this server — the
// page decodes it in the browser. It deliberately shows only a teaser: the
// question, what kind of results came back, and which extension produced them.
// Seeing the answer itself is what the app is for.

function SharedAnswer() {
  const [state, setState] = useState({status: 'reading'});
  const downloadUrl = downloadUrlForUserAgent(navigator.userAgent);

  useEffect(() => {
    const encoded = window.location.hash.replace(/^#/, '');
    if (!encoded) {
      setState({status: 'error', message: 'This link has no shared answer attached.'});
      return;
    }

    let cancelled = false;
    decodeSharePayload(encoded).then(
      (payload) => {
        if (!cancelled) setState({status: 'ready', payload, encoded});
      },
      (error) => {
        if (!cancelled) setState({status: 'error', message: error.message});
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === 'reading') {
    return <p className={styles.muted}>Reading shared answer…</p>;
  }

  if (state.status === 'error') {
    return (
      <div className={styles.card}>
        <p className={styles.error}>{state.message}</p>
        <a className={styles.primary} href={downloadUrl}>
          Download Raynard
        </a>
      </div>
    );
  }

  const {payload, encoded} = state;
  const teaser = teaserLine(payload);
  const trimmed = degradationLine(payload);
  const shared = payload.at ? new Date(payload.at) : null;

  return (
    <div className={styles.card}>
      <p className={styles.eyebrow}>Shared from Raynard</p>
      <h1 className={styles.question}>{payload.q}</h1>
      {teaser ? <p className={styles.teaser}>{teaser}</p> : null}

      <div className={styles.actions}>
        <a className={styles.primary} href={`${shareConfig.appScheme}://share/${encoded}`}>
          Open in Raynard
        </a>
        <a className={styles.secondary} href={downloadUrl}>
          Download Raynard
        </a>
      </div>

      <p className={styles.muted}>
        The answer opens in Raynard, with its result cards and every source it cited. Nothing on this
        page was uploaded — the shared answer travels inside the link itself.
      </p>
      {trimmed ? <p className={styles.muted}>{trimmed}</p> : null}
      {shared && !Number.isNaN(shared.getTime()) ? (
        <p className={styles.muted}>Shared {shared.toLocaleDateString()}</p>
      ) : null}
    </div>
  );
}

export default function SharePage() {
  return (
    <Layout title="Shared answer" description="An answer shared from Raynard.">
      <Head>
        {/* Shared answers are private links, not site content. */}
        <meta name="robots" content="noindex" />
      </Head>
      <main className={styles.main}>
        {/* The fragment only exists in the browser; Docusaurus prerenders this page. */}
        <BrowserOnly fallback={<p className={styles.muted}>Reading shared answer…</p>}>
          {() => <SharedAnswer />}
        </BrowserOnly>
      </main>
    </Layout>
  );
}
