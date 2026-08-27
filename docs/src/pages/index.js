import {useEffect, useRef, useState} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import homepageCopy from '../content/homepage-copy.json';
import shareConfig from '../../../share.config.json';
import {trackDemoVideoPlay, trackDownloadClick} from '../lib/analytics';
import {platformForUserAgent} from '../lib/download';
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

function DownloadIcon() {
  return (
    <svg
      aria-hidden="true"
      className={styles.downloadIcon}
      fill="none"
      height="18"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width="18"
    >
      <path d="M12 3v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M4 20h16" />
    </svg>
  );
}

// The link target differs per platform on purpose: macOS and Windows get the
// installer itself, while Linux gets the docs section that leads with the
// one-line install script.
function downloadTargetFor(platform) {
  if (platform === 'linux') return homepageCopy.hero.installationHelp.linuxTo;
  return shareConfig.downloads[platform];
}

function DownloadAction() {
  const {downloads, installationHelp} = homepageCopy.hero;
  // Server rendering has no user agent, so the markup starts on the macOS
  // default that `platformForUserAgent` already falls back to, then corrects
  // itself once the browser takes over.
  const [platform, setPlatform] = useState('macos');

  useEffect(() => {
    setPlatform(platformForUserAgent(navigator.userAgent));
  }, []);

  const current = downloads.platforms[platform];
  const currentTarget = downloadTargetFor(platform);
  const alternatives = downloads.order.filter((key) => key !== platform);

  return (
    <div className={styles.downloadAction}>
      <Link
        className={styles.primaryButton}
        to={currentTarget}
        onClick={() => trackDownloadClick({
          platform,
          placement: 'homepage_primary',
          url: currentTarget,
          label: current.label,
        })}
      >
        <DownloadIcon />
        {current.label}
      </Link>
      {/* Deliberately not <p>: Infima's paragraph rule is specificity-boosted
          (`p:not(#\#):not(#\#)`) and would override these margins. */}
      <div className={styles.downloadSpec}>{current.spec}</div>
      {current.note && (
        <div className={styles.downloadNote}>
          {current.note.text}
          <span aria-hidden="true"> — </span>
          <Link to={installationHelp.windowsInfoTo}>{current.note.linkLabel}</Link>
        </div>
      )}
      <div className={styles.downloadAlternatives}>
        {downloads.alternativesPrefix}{' '}
        {alternatives.map((key, index) => {
          const target = downloadTargetFor(key);
          const label = downloads.platforms[key].name;
          return (
            <span key={key}>
              {index > 0 && <span aria-hidden="true"> · </span>}
              <Link
                to={target}
                onClick={() => trackDownloadClick({
                  platform: key,
                  placement: 'homepage_alternative',
                  url: target,
                  label,
                })}
              >
                {label}
              </Link>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function DemoVideo({label, src}) {
  const videoRef = useRef(null);
  const [hasStarted, setHasStarted] = useState(false);

  const playDemo = () => {
    trackDemoVideoPlay({
      placement: 'homepage_hero',
      url: src,
      label,
    });
    setHasStarted(true);

    const playRequest = videoRef.current?.play();
    if (playRequest) {
      playRequest.catch(() => setHasStarted(false));
    }
  };

  return (
    <div className={styles.demoMedia}>
      <video
        ref={videoRef}
        className={styles.demoVideo}
        aria-label={label}
        controls={hasStarted}
        playsInline
        preload="metadata"
      >
        <source src={src} type="video/mp4" />
      </video>
      {!hasStarted && (
        <button
          className={styles.demoOverlay}
          type="button"
          aria-label={`Play ${label}`}
          onClick={playDemo}
        >
          <span className={styles.playButton} aria-hidden="true">
            <span className={styles.playIcon} aria-hidden="true" />
          </span>
        </button>
      )}
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
        <DownloadAction />

        <div className={styles.demoFrame}>
          <DemoVideo label={hero.demoLabel} src={hero.demoVideo} />
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
          {showcase.video ? (
            <video
              className={styles.showcaseMedia}
              aria-label={showcase.mediaLabel}
              autoPlay
              muted
              loop
              playsInline
              controls
              preload="metadata"
            >
              <source src={showcase.video} type="video/mp4" />
            </video>
          ) : showcase.image ? (
            <img
              className={styles.showcaseMedia}
              src={showcase.image}
              alt={showcase.mediaLabel}
              width="1920"
              height="1200"
              loading="lazy"
            />
          ) : (
            <div className={styles.screenshotPlaceholder} role="img" aria-label={showcase.mediaLabel}>
              <span>{showcases.placeholderText}</span>
            </div>
          )}
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

function TechnicalDetails() {
  const {technicalDetails} = homepageCopy;

  return (
    <section className={clsx(styles.section, styles.detailsSection)}>
      <div className={styles.sectionHeading}>
        <p className={styles.eyebrow}>{technicalDetails.eyebrow}</p>
        <Heading as="h2">{technicalDetails.title}</Heading>
      </div>
      <div className={styles.featureGrid}>
        {technicalDetails.cards.map((card) => (
          <article className={styles.featureCard} key={card.title}>
            <span className={styles.featureIcon}>{card.icon}</span>
            <h3>{card.title}</h3>
            <p>{card.body}</p>
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
      <Link
        className={styles.primaryButton}
        to={cta.action.to}
        onClick={() => trackDownloadClick({
          platform: 'chooser',
          placement: 'homepage_cta',
          url: cta.action.to,
          label: cta.action.label,
        })}
      >
        {cta.action.label}
      </Link>
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
        <TechnicalDetails />
        <CTA />
      </main>
    </Layout>
  );
}
