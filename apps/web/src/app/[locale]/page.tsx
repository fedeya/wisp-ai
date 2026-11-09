import { getTranslator, translateData, localizedPath, type Locale } from '../../i18n';
import { resolveLocale, type LocalePageProps } from '../../i18n/server';
import { localizedMetadata } from '../../seo';
import Image from 'next/image';
import { Demo } from '../../components/demo';
import { RoutineScene } from '../../components/routine-scene';
import { GearVisual, BagsVisual, Item } from '../../components/game-ui';
import { Icon } from '../../components/icon';
import { site } from '../../site';
import { getLatestRelease } from '../../release.server';
import { PageSchema } from '../../components/page-schema';
export const revalidate = 300;
const baseFaqs = [
  [
    'What do I need to get started?',
    'A Windows PC, WoW: Forever and an AI connection: ChatGPT sign-in, a supported API provider or a compatible local server. Choose a model with tool calling and keep the Wisp desktop app running while you play.',
  ],
  [
    'Your subscription or your API key?',
    'ChatGPT sign-in uses your account’s available models. API connections use your own provider credentials and billing. Compatible local servers are another option when the model supports Wisp’s tools.',
  ],
  [
    'Does Wisp play the game for me?',
    'You handle movement, combat, targeting and trading. Wisp helps with information and requested actions such as creating a new macro, placing a map marker or applying supported settings changes. It does not execute macros or put them on your action bar.',
  ],
  [
    'How do auction prices work?',
    'Wisp can read last-seen prices from Auctionator, or existing results already loaded while the auction house is open. Availability and freshness vary. It does not search or scan the auction house, or buy and sell items for you.',
  ],
  [
    'What happens to my data?',
    'Messages, relevant character readings and conversation context go to your selected AI connection and its gateway, if any. Enabled external sources receive lookup arguments. Conversations and preferences are stored locally. You control memory, integrations and tools.',
  ],
  [
    'Is this an early version?',
    'Yes. Wisp is an early release for WoW: Forever on Windows. Answers can be wrong and data coverage varies. Persistent panels and trackers are in beta; combat simulation is experimental and does not yet cover all classes and scenarios.',
  ],
];
function InstallLink({ locale }: { locale: Locale }) {
  const t = getTranslator(locale);
  return (
    <a className="button primary" href={site.download}>
      <Icon name="windows" size={17} />
      {t('Download for Windows')}
      <Icon name="arrow" size={17} />
    </a>
  );
}
const baseAbilities = [
  ['book', 'Quests & routes', 'Find the next quest, trainer or destination. Put it on your map.'],
  ['robe', 'Settings & actions', 'Create macros. Preview, apply and undo supported settings.'],
  [
    'feather',
    'Ask under your cursor',
    'Hover an item, spell or unit. Ask in context with a shortcut.',
  ],
];
export async function generateMetadata({ params }: LocalePageProps) {
  return localizedMetadata(await resolveLocale(params), '/');
}
export default async function Home({ params }: LocalePageProps) {
  const locale = await resolveLocale(params);
  const release = await getLatestRelease();
  const t = getTranslator(locale);
  const faqs = translateData(baseFaqs, locale);
  const abilities = translateData(baseAbilities, locale);
  return (
    <>
      <main id="main">
        <PageSchema
          title={t('Wisp AI \u2014 AI companion for WoW: Forever')}
          description={site.description}
          path="/"
          software
          softwareVersion={release?.version}
          locale={locale}
        />
        <section className="hero" aria-labelledby="hero-title">
          <Image
            className="hero-art"
            src="/barrens-hero-v1.avif"
            alt=""
            fill
            loading="eager"
            fetchPriority="high"
            sizes="100vw"
            unoptimized
          />
          <div className="hero-shade" />
          <div className="hero-inner container">
            <div className="hero-copy">
              <a className="release-badge" href={localizedPath(locale, '/changelog')}>
                <i />
                {t('FOR WOW: FOREVER ')}
                {release && <span>v{release.version}</span>}
              </a>
              <h1 id="hero-title">
                {t('Your AI')}
                <br />
                {t('companion.')}
                <br />
                <em>{t('Inside WoW.')}</em>
              </h1>
              <p>
                {t('Your character. Your next move.')}
                <br />
                {t('Just ask Wisp.')}
              </p>
              <InstallLink locale={locale} />
              <span className="download-note">{t('Windows x64 · Choose your AI connection')}</span>
            </div>
            <div className="hero-product">
              <Demo locale={locale} />
            </div>
          </div>
        </section>
        <section className="features container" id="features" aria-labelledby="features-title">
          <div className="section-intro">
            <span className="eyebrow">{t('A LITTLE HELP GOES A LONG WAY')}</span>
            <h2 id="features-title">
              {t('Less tabbing.')}
              <br className="mobile-break" />
              {t(' More playing.')}
            </h2>
          </div>
          <article className="feature-scene gear-scene">
            <GearVisual locale={locale} />
            <div className="feature-copy">
              <span className="eyebrow">{t('YOUR GEAR. YOUR BUDGET.')}</span>
              <h2>
                {t('Find your')}
                <br />
                {t('next upgrade.')}
              </h2>
              <p>
                {t('Know what\u2019s worth replacing.')}
                <br />
                {t('Then weigh the price against your gold.')}
              </p>
              <div className="prompt-chip">
                <Image src="/wisp.png" width={27} height={27} alt="" />
                <span>{t('\u201CWhich upgrade fits my budget?\u201D')}</span>
              </div>
              <small>{t('Uses available cached prices or loaded auction results.')}</small>
            </div>
          </article>
          <article className="feature-scene bags-scene">
            <div className="feature-copy">
              <span className="eyebrow">{t('FROM QUESTION TO ACTION')}</span>
              <h2>
                {t('Make room.')}
                <br />
                {t('Make a macro.')}
                <br />
                <em>{t('Keep going.')}</em>
              </h2>
              <p>
                {t(
                  'Figure out what\u2019s in your bags and what it\u2019s good for. Create a macro using spells you actually know.',
                )}
              </p>
              <div className="prompt-chip">
                <Image src="/wisp.png" width={27} height={27} alt="" />
                <span>{t('\u201CWhat should I keep for crafting?\u201D')}</span>
              </div>
            </div>
            <BagsVisual locale={locale} />
          </article>
          <RoutineScene locale={locale} />
          <section className="ai-choice" id="ai-choice" aria-labelledby="ai-choice-title">
            <div className="ai-choice-copy">
              <span className="eyebrow">{t('CHOOSE WHAT POWERS WISP')}</span>
              <h2 id="ai-choice-title">
                {t('Your AI.')}
                <br />
                <em>{t('Your choice.')}</em>
              </h2>
              <p>
                {t(
                  'Use your subscription, bring an API key, or connect a compatible local server.',
                )}
              </p>
              <a className="text-link" href={localizedPath(locale, '/features#ai-connections')}>
                {t('See AI connection options')}
                <Icon name="arrow" size={16} />
              </a>
            </div>
            <div className="ai-choice-connections">
              <ul className="ai-provider-list" aria-label={t('Examples of AI connections')}>
                <li>
                  <Image
                    className="provider-logo provider-logo-mono"
                    src="/providers/openai.svg"
                    width={28}
                    height={28}
                    alt=""
                  />
                  <strong>ChatGPT</strong>
                </li>
                <li>
                  <Image
                    className="provider-logo"
                    src="/providers/claude-color.svg"
                    width={28}
                    height={28}
                    alt=""
                  />
                  <strong>Claude</strong>
                </li>
                <li>
                  <Image
                    className="provider-logo"
                    src="/providers/gemini-color.svg"
                    width={28}
                    height={28}
                    alt=""
                  />
                  <strong>Gemini</strong>
                </li>
                <li>
                  <Image
                    className="provider-logo provider-logo-mono"
                    src="/providers/openrouter.svg"
                    width={28}
                    height={28}
                    alt=""
                  />
                  <strong>OpenRouter</strong>
                </li>
                <li className="local-provider">
                  <Icon name="connection" size={28} />
                  <div>
                    <strong>{t('Local models')}</strong>
                  </div>
                </li>
              </ul>
              <div className="ai-choice-note">
                <Image src="/wisp.png" width={26} height={26} alt="" />
                <p>
                  {t('The same Wisp. Your preferred connection.')}
                  <small>
                    {t('Choose a model with tool calling. Compatibility varies by model.')}
                  </small>
                </p>
              </div>
            </div>
          </section>
          <section className="more-capabilities" aria-labelledby="more-capabilities-title">
            <span className="eyebrow">{t('MORE WAYS TO USE WISP')}</span>
            <h2 id="more-capabilities-title">{t('A little help, wherever you need it.')}</h2>
            <div className="abilities">
              {abilities.map(([icon, title, text]) => (
                <article key={title}>
                  <Item icon={icon} name={title} />
                  <div>
                    <h3>{title}</h3>
                    <p>{text}</p>
                  </div>
                </article>
              ))}
            </div>
            <a
              className="text-link feature-reference-link"
              href={localizedPath(locale, '/features')}
            >
              {t('Explore all features ')}
              <Icon name="arrow" size={16} />
            </a>
            <div className="connected-sources">
              <div className="sources-heading">
                <h3>{t('Connect the addons you already use.')}</h3>
                <p>{t('Give Wisp more context through optional addons and knowledge sources.')}</p>
              </div>
              <ul className="source-list">
                <li>
                  <strong>{t('Questie')}</strong>
                  <span>{t('Quests & NPC locations')}</span>
                </li>
                <li>
                  <strong>{t('Auctionator')}</strong>
                  <span>{t('Last-seen auction prices')}</span>
                </li>
                <li>
                  <strong>{t('Syndicator')}</strong>
                  <span>{t('Bags across characters')}</span>
                </li>
                <li>
                  <strong>{t('Forever databases')}</strong>
                  <span>{t('Items & crafting references')}</span>
                </li>
              </ul>
              <p className="custom-tools">
                <Icon name="plus" size={13} />
                <span>{t('Add your own tools with MCP connections.')}</span>
              </p>
            </div>
          </section>
          <div className="development">
            <div>
              <span className="beta-label">{t('BETA')}</span>
              <strong>{t('Panels & trackers')}</strong>
              <p>{t('Keep materials, gold and progress in view.')}</p>
            </div>
            <div>
              <span className="beta-label">{t('EXPERIMENTAL')}</span>
              <strong>{t('Combat simulation')}</strong>
              <p>{t('Compare supported setups. Coverage is growing.')}</p>
            </div>
          </div>
        </section>
        <section className="setup-section" id="start">
          <div className="container">
            <span className="eyebrow">{t('BACK TO YOUR ADVENTURE')}</span>
            <h2>{t('A few steps to summon Wisp.')}</h2>
            <ol className="setup-steps">
              <li>
                <span>01</span>
                <h3>{t('Install Wisp')}</h3>
                <p>{t('Choose your WoW folder and install the addon from the desktop app.')}</p>
              </li>
              <li>
                <span>02</span>
                <h3>{t('Connect your AI')}</h3>
                <p>{t('Sign in with ChatGPT or add an API connection, then choose your model.')}</p>
              </li>
              <li>
                <span>03</span>
                <h3>
                  {t('Type ')}
                  <code>{t('/wisp')}</code>
                </h3>
                <p>{t('Restart WoW, enable the addons and keep Wisp running while you play.')}</p>
              </li>
            </ol>
            <a className="text-link" href={localizedPath(locale, '/setup')}>
              {t('Full setup guide ')}
              <Icon name="arrow" size={16} />
            </a>
          </div>
        </section>
        <section className="faq-section container">
          <h2>{t('Before you set out.')}</h2>
          <div className="faq-list">
            {faqs.map(([question, answer]) => (
              <details key={question}>
                <summary>
                  {question}
                  <Icon name="plus" size={17} />
                </summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
        </section>
        <section className="install-section container">
          <Image src="/wisp.png" width={70} height={70} alt="" />
          <h2>
            {t('A little company.')}
            <br />
            {t('A better adventure.')}
          </h2>
          <InstallLink locale={locale} />
          <p className="download-note">
            {release && `v${release.version}`}
            {t(' · Windows x64 · Open source')}
          </p>
        </section>
      </main>
    </>
  );
}
