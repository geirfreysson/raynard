import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import homepageCopy from '../content/homepage-copy.json';
import styles from './index.module.css';

const extensionRowB = [...homepageCopy.extensions.items].reverse();

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
  const {hero, extensions} = homepageCopy;

  return (
    <>
      <header className={styles.hero}>
        <p className={styles.eyebrow}>{hero.eyebrow}</p>
        <Heading as="h1" className={styles.heroTitle}>{hero.title}</Heading>
        <p className={styles.heroSlogan}>
          {hero.slogan.before} <span>{hero.slogan.emphasis}</span> {hero.slogan.after}
        </p>
        <p className={styles.heroBody}>{hero.body}</p>
        <div className={styles.heroActions}>
          <Link className={styles.primaryButton} to={hero.primaryAction.to}>{hero.primaryAction.label}</Link>
          <Link className={styles.secondaryButton} to={hero.secondaryAction.to}>{hero.secondaryAction.label}</Link>
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
            <span className={styles.demoLabel}>{hero.demoLabel}</span>
          </div>
        </div>
      </header>

      {extensions.enabled && (
        <section className={styles.extensionsSection} aria-labelledby="extensions-heading">
          <h2 className={styles.eyebrow} id="extensions-heading">{extensions.heading}</h2>
          <div className={styles.extensionMarquee}>
            <ExtensionRow items={extensions.items} />
            <ExtensionRow items={extensionRowB} reverse />
          </div>
        </section>
      )}
    </>
  );
}

function PromptShowcases() {
  const {showcases} = homepageCopy;

  return (
    <section className={styles.showcaseSection} aria-label={showcases.ariaLabel}>
      {showcases.items.map((showcase) => (
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
            aria-label={showcase.mediaLabel}
          >
            <span>{showcases.placeholderText}</span>
          </div>
        </article>
      ))}
    </section>
  );
}

function Features() {
  const {features} = homepageCopy;

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeading}>
        <p className={styles.eyebrow}>{features.eyebrow}</p>
        <Heading as="h2">{features.title}</Heading>
      </div>
      <div className={styles.featureGrid}>
        {features.cards.map((feature) => (
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
  const {howItWorks} = homepageCopy;

  return (
    <section className={clsx(styles.section, styles.stepsSection)}>
      <div className={styles.sectionHeading}>
        <p className={styles.eyebrow}>{howItWorks.eyebrow}</p>
        <Heading as="h2">{howItWorks.title}</Heading>
      </div>
      <div className={styles.steps}>
        {howItWorks.steps.map((step, index) => (
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
  const {cta} = homepageCopy;

  return (
    <section className={styles.cta}>
      <Heading as="h2">{cta.title}</Heading>
      <p>{cta.body}</p>
      <Link className={styles.primaryButton} to={cta.action.to}>{cta.action.label}</Link>
    </section>
  );
}

export default function Home() {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout title={siteConfig.title} description={homepageCopy.meta.description}>
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
