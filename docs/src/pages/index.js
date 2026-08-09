import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import styles from './index.module.css';

const extensionRowA = [
  'Postgres', 'Snowflake', 'BigQuery', 'Stripe', 'Salesforce',
  'HubSpot', 'Slack', 'Notion', 'Zendesk', 'QuickBooks',
  'Shopify', 'Sheets', 'S3', 'MongoDB', 'Twilio',
  'Plaid', 'Segment', 'Mixpanel', 'Airtable', 'Your API',
];

const extensionRowB = [...extensionRowA].reverse();

const featureCards = [
  {
    icon: '”',
    title: 'Cited answers',
    body: 'Every figure Raynard gives you links back to the API response and source reference it came from.',
  },
  {
    icon: '⇄',
    title: 'Connect anything',
    body: 'Send Raynard a link to an API’s docs and it can build the connection for you—no config files.',
  },
  {
    icon: '$',
    title: 'Plain English, real numbers',
    body: 'Ask questions the way you would ask a colleague. Get grounded numbers, not guesses.',
  },
  {
    icon: '⌘',
    title: 'Native to your Mac',
    body: 'A real desktop app that keeps conversations, connections, and credentials under your control.',
  },
];

const steps = [
  {
    title: 'Point it at your data',
    body: 'Paste a link to an API’s docs or request a data source. Raynard sets up the extension after you approve it.',
  },
  {
    title: 'Ask in plain English',
    body: 'No query language and no dashboard to build. Just type the question you actually have.',
  },
  {
    title: 'Get answers with receipts',
    body: 'Every number retains its source, so you can double-check the evidence before you rely on it.',
  },
];

const promptShowcases = [
  {
    title: 'Refunds, broken down and sourced',
    prompt: 'What was our Stripe refund rate last quarter, by plan?',
    body: 'With a Stripe plugin installed, Raynard can compare refunds and charges and break the result down by plan.',
    bullets: [
      'Returns source references with the supporting transactions',
      'Queries the API again when you rerun the question',
    ],
    mediaLabel: 'Stripe refund analysis screenshot',
  },
  {
    title: 'Find leads that went quiet',
    prompt: 'Which Salesforce leads went cold after their demo?',
    body: 'An installed Salesforce plugin can compare demo dates with the latest recorded activity.',
    bullets: [
      'Returns the matching records with source links',
      'Keeps the supporting API response with the result',
    ],
    mediaLabel: 'Salesforce lead analysis screenshot',
    reverse: true,
  },
  {
    title: 'Surface inventory below target',
    prompt: 'Show me warehouse inventory turns below target this month.',
    body: 'A generated inventory plugin can compare current records with the target thresholds exposed by its API.',
    bullets: [
      'Returns the affected SKUs with supporting references',
      'Reruns against current data when thresholds change',
    ],
    mediaLabel: 'Warehouse inventory analysis screenshot',
  },
];

function ExtensionRow({items, reverse = false}) {
  const repeated = [...items, ...items];
  return (
    <div className={clsx(styles.extensionTrack, reverse && styles.extensionTrackReverse)}>
      {repeated.map((extension, index) => (
        <div className={styles.extensionCard} key={`${extension}-${index}`} aria-hidden={index >= items.length}>
          <span>{extension}</span>
        </div>
      ))}
    </div>
  );
}

function Hero() {
  return (
    <>
      <header className={styles.hero}>
        <p className={styles.eyebrow}>Desktop app for macOS</p>
        <Heading as="h1" className={styles.heroTitle}>The AI analyst that cites its sources</Heading>
        <p className={styles.heroSlogan}>
          Talk <span>data</span> to me.
        </p>
        <p className={styles.heroBody}>
          Raynard connects to data APIs so you can ask questions in plain English—every number comes back with a reference you can check.
        </p>
        <div className={styles.heroActions}>
          <Link className={styles.primaryButton} to="/docs/getting-started">Download for macOS</Link>
          <Link className={styles.secondaryButton} to="/docs/intro">Read the Docs</Link>
        </div>

        <div className={styles.demoFrame}>
          <div className={styles.demoChrome} aria-hidden="true">
            <span className={styles.dotRed} />
            <span className={styles.dotYellow} />
            <span className={styles.dotGreen} />
          </div>
          <div className={styles.demoMedia}>
            <div className={styles.playButton} aria-hidden="true">
              <span className={styles.playIcon} />
            </div>
            <span className={styles.demoLabel}>Product demo — cited answers from live API data</span>
          </div>
        </div>
      </header>

      <section className={styles.extensionsSection} aria-labelledby="extensions-heading">
        <h2 className={styles.eyebrow} id="extensions-heading">40+ extensions, ready on install</h2>
        <div className={styles.extensionMarquee}>
          <ExtensionRow items={extensionRowA} />
          <ExtensionRow items={extensionRowB} reverse />
        </div>
      </section>
    </>
  );
}

function PromptShowcases() {
  return (
    <section className={styles.showcaseSection} aria-label="Example prompts">
      {promptShowcases.map((showcase) => (
        <article
          className={clsx(styles.showcaseRow, showcase.reverse && styles.showcaseRowReverse)}
          key={showcase.title}
        >
          <div className={styles.showcaseText}>
            <Heading as="h3">{showcase.title}</Heading>
            <div className={styles.promptQuote}>
              <span aria-hidden="true">&gt;</span>
              <q>{showcase.prompt}</q>
            </div>
            <p>{showcase.body}</p>
            <ul>
              {showcase.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}
            </ul>
          </div>
          <div
            className={styles.screenshotPlaceholder}
            role="img"
            aria-label={`Placeholder for ${showcase.mediaLabel}`}
          >
            <span>Screenshot</span>
          </div>
        </article>
      ))}
    </section>
  );
}

function Features() {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeading}>
        <p className={styles.eyebrow}>Why Raynard</p>
        <Heading as="h2">Built for analysts who need proof</Heading>
      </div>
      <div className={styles.featureGrid}>
        {featureCards.map((feature) => (
          <article className={styles.featureCard} key={feature.title}>
            <span className={styles.featureIcon}>{feature.icon}</span>
            <h3>{feature.title}</h3>
            <p>{feature.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section className={clsx(styles.section, styles.stepsSection)}>
      <div className={styles.sectionHeading}>
        <p className={styles.eyebrow}>How it works</p>
        <Heading as="h2">From question to receipt in three steps</Heading>
      </div>
      <div className={styles.steps}>
        {steps.map((step, index) => (
          <article className={styles.step} key={step.title}>
            <span className={styles.stepNumber}>{index + 1}</span>
            <h3>{step.title}</h3>
            <p>{step.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function CTA() {
  return (
    <section className={styles.cta}>
      <Heading as="h2">Ready to talk data?</Heading>
      <p>Connect your sources and start asking questions.</p>
      <Link className={styles.primaryButton} to="/docs/getting-started">Download for macOS</Link>
    </section>
  );
}

export default function Home() {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout title={siteConfig.title} description="Talk to data APIs in plain English with Raynard.">
      <main className={styles.page}>
        <Hero />
        <Features />
        <PromptShowcases />
        <HowItWorks />
        <CTA />
      </main>
    </Layout>
  );
}
