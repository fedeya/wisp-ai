import { containerClassName } from '../../components/ui';
import sharedStyles from '../../components/shared.module.css';
import styles from './page.module.css';
import { getTranslator, translateData, localizedPath, type Locale } from '../../i18n';
import { resolveLocale, type LocalePageProps } from '../../i18n/server';
import { localizedMetadata } from '../../seo';
import Image from 'next/image';
import { HeroMotion } from '../../components/hero-motion';
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
    <a
      className={`button primary gap-[12px] border border-solid border-[#efdaab] px-[22px] py-0 inline-flex min-h-[48px] items-center justify-center rounded-[4px] text-[13px] font-semibold text-[#241c10] ${sharedStyles['button']} ${sharedStyles['primary']}`}
      href={site.download}
    >
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
        <section
          className={`hero relative isolate mt-[-64px] min-h-[750px] pt-[64px] md:mt-[-82px] md:pt-[82px] 2xl:min-h-[840px] ${styles['hero']}`}
          aria-labelledby="hero-title"
        >
          <Image
            className="hero-art object-cover [object-position:66%_50%] z-[-3] md:[object-position:50%_56%] 2xl:[object-position:50%_60%]"
            src="/barrens-hero-v1.avif"
            alt=""
            fill
            loading="eager"
            fetchPriority="high"
            sizes="100vw"
            unoptimized
          />
          <div
            className={`hero-shade absolute top-[0] right-[0] bottom-[0] left-[0] z-[-2] ${styles['hero-shade']}`}
          />
          <HeroMotion>
            <div
              className={`hero-copy z-[2] pb-0 md:pb-[12px] ${styles['hero-copy']}`}
              data-hero-copy
            >
              <a
                className={`release-badge gap-[9px] flex items-center text-[9px] tracking-[1.6px] text-[#d6c8af] mb-[23px] md:text-[10px] md:mb-[25px] ${styles['release-badge']}`}
                href={`${site.repository}/releases`}
              >
                <i className="w-[5px] h-[5px] rounded-[50%]" />
                {t('FOR WOW: FOREVER ')}
                {release && (
                  <span className="tracking-[0] text-[#a99d89] border-l-[1px] [border-left-style:solid] border-l-[#b9a17d50] pl-[9px]">
                    v{release.version}
                  </span>
                )}
              </a>
              <h1
                id="hero-title"
                className="text-[clamp(49px,_15.7vw,_62px)] leading-[1.12] tracking-[-2.5px] md:text-[66px] md:tracking-[-3px] lg:text-[clamp(58px,_5.8vw,_84px)] 2xl:text-[88px]"
              >
                {t('Your AI')}
                <br />
                {t('companion.')}
                <br />
                <em>{t('Inside WoW.')}</em>
              </h1>
              <p className="mx-0 text-[#ddd3c2] text-[15px] leading-[1.6] mt-[21px] mb-[24px] md:text-[17px] md:mt-[24px] md:mb-[28px]">
                {t('Your character. Your next move.')}
                <br />
                {t('Just ask Wisp.')}
              </p>
              <InstallLink locale={locale} />
              <span className="download-note mt-[13px] block text-[11px] leading-[1.6] text-[#b8ad99]">
                {t('Windows x64 · Choose your AI connection')}
              </span>
            </div>
            <div
              className="hero-product py-0 relative min-h-[0] self-[center] flex justify-end mt-[40px] md:mt-0 md:pb-0"
              data-hero-product
            >
              <Demo locale={locale} />
            </div>
          </HeroMotion>
        </section>
        <section
          className={`${containerClassName} features pt-[60px] md:pt-[48px]`}
          id="features"
          aria-labelledby="features-title"
        >
          <div className="section-intro mx-0 text-center mt-0 mb-[22px] md:mb-[55px]">
            <span className="eyebrow block text-[#a3906f] text-[8px] tracking-[2px] leading-[1.8] mb-[16px] md:text-[9px]">
              {t('A LITTLE HELP GOES A LONG WAY')}
            </span>
            <h2
              id="features-title"
              className="text-[37px] sm:text-[41px] md:text-[clamp(36px,_4.4vw,_58px)]"
            >
              {t('Less tabbing.')}
              <br className="mobile-break block md:hidden" />
              {t(' More playing.')}
            </h2>
          </div>
          <article
            className={`feature-scene gear-scene gap-[30px] px-0 py-[64px] grid grid-cols-[1fr] items-center relative md:gap-[45px] md:py-[85px] md:grid-cols-[1fr_1fr] lg:gap-[90px] ${styles['feature-scene']} ${styles['gear-scene']}`}
          >
            <GearVisual locale={locale} />
            <div
              className={`feature-copy row-[1] pl-0 w-full max-w-[none] justify-self-[start] md:max-w-[360px] md:justify-self-[end] md:row-auto ${styles['feature-copy']}`}
            >
              <span className="eyebrow block text-[#a3906f] text-[8px] tracking-[2px] leading-[1.8] mb-[14px] md:text-[9px] md:mb-[16px]">
                {t('YOUR GEAR. YOUR BUDGET.')}
              </span>
              <h2 className="text-[43px] sm:text-[46px] lg:text-[54px]">
                {t('Find your')}
                <br />
                {t('next upgrade.')}
              </h2>
              <p className="text-muted text-[14px] leading-[1.7] max-w-[340px] mt-[18px] md:text-[15px] md:mt-[22px]">
                {t('Know what\u2019s worth replacing.')}
                <br />
                {t('Then weigh the price against your gold.')}
              </p>
              <div
                className={`prompt-chip gap-[10px] flex items-center mt-[22px] text-[12px] text-[#d3c1a0] md:mt-[26px] ${styles['prompt-chip']}`}
              >
                <Image src="/wisp.png" width={27} height={27} alt="" />
                <span className="border border-solid border-[#c5a66d3d] px-[13px] py-[10px] rounded-[5px]">
                  {t('\u201CWhich upgrade fits my budget?\u201D')}
                </span>
              </div>
              <small className="block text-[#a19887] text-[9px] leading-[1.5] mt-[16px] max-w-[300px] md:text-[10px]">
                {t('Uses available cached prices or loaded auction results.')}
              </small>
            </div>
          </article>
          <article
            className={`feature-scene bags-scene gap-[30px] px-0 py-[64px] grid grid-cols-[1fr] items-center relative md:gap-[45px] md:py-[85px] md:grid-cols-[1fr_1fr] lg:gap-[90px] ${styles['feature-scene']}`}
          >
            <div className={`feature-copy ${styles['feature-copy']}`}>
              <span className="eyebrow block text-[#a3906f] text-[8px] tracking-[2px] leading-[1.8] mb-[14px] md:text-[9px] md:mb-[16px]">
                {t('FROM QUESTION TO ACTION')}
              </span>
              <h2 className="text-[43px] sm:text-[46px] lg:text-[54px]">
                {t('Make room.')}
                <br />
                {t('Make a macro.')}
                <br />
                <em>{t('Keep going.')}</em>
              </h2>
              <p className="text-muted text-[14px] leading-[1.7] max-w-[340px] mt-[18px] md:text-[15px] md:mt-[22px]">
                {t(
                  'Figure out what\u2019s in your bags and what it\u2019s good for. Create a macro using spells you actually know.',
                )}
              </p>
              <div
                className={`prompt-chip gap-[10px] flex items-center mt-[22px] text-[12px] text-[#d3c1a0] md:mt-[26px] ${styles['prompt-chip']}`}
              >
                <Image src="/wisp.png" width={27} height={27} alt="" />
                <span className="border border-solid border-[#c5a66d3d] px-[13px] py-[10px] rounded-[5px]">
                  {t('\u201CWhat should I keep for crafting?\u201D')}
                </span>
              </div>
            </div>
            <BagsVisual locale={locale} />
          </article>
          <RoutineScene locale={locale} />
          <section
            className="ai-choice gap-[35px] px-0 grid grid-cols-[1fr] items-center pt-[62px] pb-[50px] border-t-[1px] [border-top-style:solid] border-t-[var(--line)] md:gap-[55px] md:grid-cols-[1fr_1fr] md:pt-[88px] md:pb-[80px] lg:gap-[100px]"
            id="ai-choice"
            aria-labelledby="ai-choice-title"
          >
            <div className="ai-choice-copy">
              <span className="eyebrow block text-[#a3906f] text-[9px] tracking-[2px] leading-[1.8] mb-[16px]">
                {t('CHOOSE WHAT POWERS WISP')}
              </span>
              <h2
                id="ai-choice-title"
                className="text-[43px] leading-[1.12] sm:text-[46px] lg:text-[54px]"
              >
                {t('Your AI.')}
                <br />
                <em>{t('Your choice.')}</em>
              </h2>
              <p className="text-muted text-[14px] leading-[1.8] max-w-[355px] mt-[20px] md:text-[15px] md:mt-[23px]">
                {t(
                  'Use your subscription, bring an API key, or connect a compatible local server.',
                )}
              </p>
              <a
                className={`text-link gap-[9px] inline-flex items-center text-gold text-[12px] mt-[25px] ${sharedStyles['text-link']}`}
                href={localizedPath(locale, '/features#ai-connections')}
              >
                {t('See AI connection options')}
                <Icon name="arrow" size={16} />
              </a>
            </div>
            <div className="ai-choice-connections w-full max-w-[440px] justify-self-[start] md:justify-self-[end]">
              <ul
                className={`ai-provider-list gap-[10px] p-0 m-0 grid grid-cols-[1fr_1fr] list-none sm:gap-[12px] ${styles['ai-provider-list']}`}
                aria-label={t('Examples of AI connections')}
              >
                <li className="gap-[9px] border border-solid border-[#b79c633b] px-[13px] py-[16px] rounded-[5px] flex items-start min-h-[81px] flex-col sm:gap-[11px] sm:p-[18px] md:gap-[14px] md:p-[20px] md:items-center md:min-h-[89px] md:flex-row">
                  <Image
                    className={`provider-logo provider-logo-mono shrink-0 w-[25px] h-[25px] sm:w-[28px] sm:h-[28px] ${styles['provider-logo-mono']}`}
                    src="/providers/openai.svg"
                    width={28}
                    height={28}
                    alt=""
                  />
                  <strong className="block text-[17px] [font-family:Georgia,_serif] font-normal not-italic [line-height:normal] text-[#e0d3bb] sm:text-[19px] md:text-[22px]">
                    ChatGPT
                  </strong>
                </li>
                <li className="gap-[9px] border border-solid border-[#b79c633b] px-[13px] py-[16px] rounded-[5px] flex items-start min-h-[81px] flex-col sm:gap-[11px] sm:p-[18px] md:gap-[14px] md:p-[20px] md:items-center md:min-h-[89px] md:flex-row">
                  <Image
                    className="provider-logo shrink-0 w-[25px] h-[25px] sm:w-[28px] sm:h-[28px]"
                    src="/providers/claude-color.svg"
                    width={28}
                    height={28}
                    alt=""
                  />
                  <strong className="block text-[17px] [font-family:Georgia,_serif] font-normal not-italic [line-height:normal] text-[#e0d3bb] sm:text-[19px] md:text-[22px]">
                    Claude
                  </strong>
                </li>
                <li className="gap-[9px] border border-solid border-[#b79c633b] px-[13px] py-[16px] rounded-[5px] flex items-start min-h-[81px] flex-col sm:gap-[11px] sm:p-[18px] md:gap-[14px] md:p-[20px] md:items-center md:min-h-[89px] md:flex-row">
                  <Image
                    className="provider-logo shrink-0 w-[25px] h-[25px] sm:w-[28px] sm:h-[28px]"
                    src="/providers/gemini-color.svg"
                    width={28}
                    height={28}
                    alt=""
                  />
                  <strong className="block text-[17px] [font-family:Georgia,_serif] font-normal not-italic [line-height:normal] text-[#e0d3bb] sm:text-[19px] md:text-[22px]">
                    Gemini
                  </strong>
                </li>
                <li className="gap-[9px] border border-solid border-[#b79c633b] px-[13px] py-[16px] rounded-[5px] flex items-start min-h-[81px] flex-col sm:gap-[11px] sm:p-[18px] md:gap-[14px] md:p-[20px] md:items-center md:min-h-[89px] md:flex-row">
                  <Image
                    className={`provider-logo provider-logo-mono shrink-0 w-[25px] h-[25px] sm:w-[28px] sm:h-[28px] ${styles['provider-logo-mono']}`}
                    src="/providers/openrouter.svg"
                    width={28}
                    height={28}
                    alt=""
                  />
                  <strong className="block text-[17px] [font-family:Georgia,_serif] font-normal not-italic [line-height:normal] text-[#e0d3bb] sm:text-[19px] md:text-[22px]">
                    OpenRouter
                  </strong>
                </li>
                <li
                  className={`local-provider gap-[14px] border border-solid border-[#b79c633b] px-[13px] py-[16px] rounded-[5px] flex items-center min-h-[81px] flex-row col-[1_/_-1] sm:p-[18px] md:p-[20px] md:min-h-[89px] md:flex-row ${styles['local-provider']}`}
                >
                  <Icon name="connection" size={28} />
                  <div>
                    <strong className="block text-[17px] [font-family:Georgia,_serif] font-normal not-italic [line-height:normal] text-[#e0d3bb] sm:text-[19px] md:text-[22px]">
                      {t('Local models')}
                    </strong>
                  </div>
                </li>
              </ul>
              <div className="ai-choice-note gap-[10px] flex items-start pt-[22px]">
                <Image
                  src="/wisp.png"
                  width={26}
                  height={26}
                  alt=""
                  className="shrink-0 mt-[1px]"
                />
                <p className="text-[#c5b695] text-[11px] leading-[1.7]">
                  {t('The same Wisp. Your preferred connection.')}
                  <small className="block mt-[7px] text-[#9a907e] text-[10px] leading-[1.7]">
                    {t('Choose a model with tool calling. Compatibility varies by model.')}
                  </small>
                </p>
              </div>
            </div>
          </section>
          <section
            className={`more-capabilities border-t-[1px] [border-top-style:solid] border-t-[var(--line)] pt-[48px] pb-[44px] md:pt-[64px] md:pb-[58px] ${styles['more-capabilities']}`}
            aria-labelledby="more-capabilities-title"
          >
            <span className="eyebrow block text-[#a3906f] text-[9px] tracking-[2px] leading-[1.8] mb-[16px]">
              {t('MORE WAYS TO USE WISP')}
            </span>
            <h2
              id="more-capabilities-title"
              className="text-[34px] leading-[1.2] tracking-[-1px] md:text-[38px]"
            >
              {t('A little help, wherever you need it.')}
            </h2>
            <div
              className={`abilities gap-[12px] px-0 grid grid-cols-[1fr] border-t-[0] [border-top-style:none] border-t-[currentColor] pt-[25px] pb-[30px] md:gap-[18px] md:grid-cols-[repeat(3,_1fr)] md:pt-[30px] md:pb-[38px] ${styles['abilities']}`}
            >
              {abilities.map(([icon, title, text]) => (
                <article
                  key={title}
                  className="gap-[14px] border border-solid border-[#c6ad7b24] p-[18px] flex items-start rounded-[5px] flex-row md:gap-[12px] md:py-[22px] md:flex-col lg:gap-[14px] lg:flex-row"
                >
                  <Item icon={icon} name={title} />
                  <div>
                    <h3 className="mx-0 text-[15px] mt-[2px] mb-[9px]">{title}</h3>
                    <p className="text-[12px] leading-[1.75] text-muted max-w-[330px] md:max-w-[245px]">
                      {text}
                    </p>
                  </div>
                </article>
              ))}
            </div>
            <a
              className={`text-link feature-reference-link gap-[9px] mx-0 inline-flex items-center text-gold text-[12px] mt-[-12px] mb-[32px] ${sharedStyles['text-link']}`}
              href={localizedPath(locale, '/features')}
            >
              {t('Explore all features ')}
              <Icon name="arrow" size={16} />
            </a>
            <div className="connected-sources pt-[30px] border-t-[1px] [border-top-style:solid] border-t-[var(--line)]">
              <div className="sources-heading">
                <h3 className="text-[23px] [font-family:Georgia,_serif] font-normal not-italic leading-[1.3] text-[#ded1ba] md:text-[24px] md:[line-height:normal]">
                  {t('Connect the addons you already use.')}
                </h3>
                <p className="text-[12px] text-muted mt-[10px] leading-[1.7]">
                  {t('Give Wisp more context through optional addons and knowledge sources.')}
                </p>
              </div>
              <ul className="source-list gap-[20px] p-0 mx-0 list-none mt-[25px] mb-0 grid grid-cols-[1fr] sm:grid-cols-[1fr_1fr] sm:gap-y-[22px] sm:gap-x-[14px] md:gap-[24px] md:grid-cols-[repeat(4,_1fr)]">
                <li className="pl-[13px] border-l-[1px] [border-left-style:solid] border-l-[#ae8f584d]">
                  <strong className="text-[13px] font-medium text-[#d7c5a4] block mb-[7px]">
                    {t('Questie')}
                  </strong>
                  <span className="text-[#938a79] text-[11px] leading-[1.7] block">
                    {t('Quests & NPC locations')}
                  </span>
                </li>
                <li className="pl-[13px] border-l-[1px] [border-left-style:solid] border-l-[#ae8f584d]">
                  <strong className="text-[13px] font-medium text-[#d7c5a4] block mb-[7px]">
                    {t('Auctionator')}
                  </strong>
                  <span className="text-[#938a79] text-[11px] leading-[1.7] block">
                    {t('Last-seen auction prices')}
                  </span>
                </li>
                <li className="pl-[13px] border-l-[1px] [border-left-style:solid] border-l-[#ae8f584d]">
                  <strong className="text-[13px] font-medium text-[#d7c5a4] block mb-[7px]">
                    {t('Syndicator')}
                  </strong>
                  <span className="text-[#938a79] text-[11px] leading-[1.7] block">
                    {t('Bags across characters')}
                  </span>
                </li>
                <li className="pl-[13px] border-l-[1px] [border-left-style:solid] border-l-[#ae8f584d]">
                  <strong className="text-[13px] font-medium text-[#d7c5a4] block mb-[7px]">
                    {t('Forever databases')}
                  </strong>
                  <span className="text-[#938a79] text-[11px] leading-[1.7] block">
                    {t('Items & crafting references')}
                  </span>
                </li>
              </ul>
              <p className="custom-tools gap-[7px] flex items-center text-[#97896f] text-[10px] leading-[1.6] mt-[25px]">
                <Icon name="plus" size={13} />
                <span>{t('Add your own tools with MCP connections.')}</span>
              </p>
            </div>
          </section>
          <div className="development gap-[23px] px-0 py-[25px] border-t-[1px] [border-top-style:solid] border-t-[var(--line)] border-b-[1px] [border-bottom-style:solid] border-b-[var(--line)] grid grid-cols-[1fr] mt-[10px] md:gap-[40px] md:grid-cols-[1fr_1fr] md:pt-[27px] md:pb-[29px] md:mt-[16px]">
            <div className="grid grid-cols-[100px_1fr] items-center gap-x-[10px] sm:grid-cols-[110px_1fr] md:grid-cols-[auto_1fr] md:gap-x-[13px]">
              <span className="beta-label border border-solid border-[#bba16b3a] px-[7px] py-[5px] text-[8px] tracking-[1px] text-[#b7a17c] rounded-[3px] self-[start] justify-self-[start] md:justify-self-auto">
                {t('BETA')}
              </span>
              <strong className="text-[13px] font-medium">{t('Panels & trackers')}</strong>
              <p className="col-[2] text-[#918a7c] text-[10px] mt-[7px] leading-[1.6] md:text-[11px] md:mt-[6px]">
                {t('Keep materials, gold and progress in view.')}
              </p>
            </div>
            <div className="grid grid-cols-[100px_1fr] items-center gap-x-[10px] sm:grid-cols-[110px_1fr] md:grid-cols-[auto_1fr] md:gap-x-[13px]">
              <span className="beta-label border border-solid border-[#bba16b3a] px-[7px] py-[5px] text-[8px] tracking-[1px] text-[#b7a17c] rounded-[3px] self-[start] justify-self-[start] md:justify-self-auto">
                {t('EXPERIMENTAL')}
              </span>
              <strong className="text-[13px] font-medium">{t('Combat simulation')}</strong>
              <p className="col-[2] text-[#918a7c] text-[10px] mt-[7px] leading-[1.6] md:text-[11px] md:mt-[6px]">
                {t('Compare supported setups. Coverage is growing.')}
              </p>
            </div>
          </div>
        </section>
        <section
          className={`setup-section px-0 py-[64px] mt-[60px] border-t-[1px] [border-top-style:solid] border-t-[var(--line)] md:py-[100px] md:mt-[90px] ${styles['setup-section']}`}
          id="start"
        >
          <div className={`${containerClassName} `}>
            <span className="eyebrow block text-[#a3906f] text-[9px] tracking-[2px] leading-[1.8] mb-[16px]">
              {t('BACK TO YOUR ADVENTURE')}
            </span>
            <h2 className="text-[36px] md:text-[44px]">{t('A few steps to summon Wisp.')}</h2>
            <ol className="setup-steps gap-[25px] p-0 mx-0 my-[30px] grid grid-cols-[1fr] list-none md:gap-[45px] md:grid-cols-[repeat(3,_1fr)] md:mt-[40px] md:mb-[27px]">
              <li className="grid grid-cols-[35px_1fr] gap-x-[14px] md:block">
                <span className="m-0 text-[20px] [font-family:Georgia,_serif] font-normal not-italic [line-height:normal] text-[#a98c56] block row-[span_2] md:mx-0 md:mb-[15px] md:row-auto md:mt-0">
                  01
                </span>
                <h3 className="text-[15px] mb-[7px] md:mb-[11px]">{t('Install Wisp')}</h3>
                <p className="text-[12px] leading-[1.8] text-muted max-w-full md:max-w-[290px]">
                  {t('Choose your WoW folder and install the addon from the desktop app.')}
                </p>
              </li>
              <li className="grid grid-cols-[35px_1fr] gap-x-[14px] md:block">
                <span className="m-0 text-[20px] [font-family:Georgia,_serif] font-normal not-italic [line-height:normal] text-[#a98c56] block row-[span_2] md:mx-0 md:mb-[15px] md:row-auto md:mt-0">
                  02
                </span>
                <h3 className="text-[15px] mb-[7px] md:mb-[11px]">{t('Connect your AI')}</h3>
                <p className="text-[12px] leading-[1.8] text-muted max-w-full md:max-w-[290px]">
                  {t('Sign in with ChatGPT or add an API connection, then choose your model.')}
                </p>
              </li>
              <li className="grid grid-cols-[35px_1fr] gap-x-[14px] md:block">
                <span className="m-0 text-[20px] [font-family:Georgia,_serif] font-normal not-italic [line-height:normal] text-[#a98c56] block row-[span_2] md:mx-0 md:mb-[15px] md:row-auto md:mt-0">
                  03
                </span>
                <h3 className="text-[15px] mb-[7px] md:mb-[11px]">
                  {t('Type ')}
                  <code className="text-[14px] text-[#d8c59e]">{t('/wisp')}</code>
                </h3>
                <p className="text-[12px] leading-[1.8] text-muted max-w-full md:max-w-[290px]">
                  {t('Restart WoW, enable the addons and keep Wisp running while you play.')}
                </p>
              </li>
            </ol>
            <a
              className={`text-link gap-[9px] inline-flex items-center text-gold text-[12px] ${sharedStyles['text-link']}`}
              href={localizedPath(locale, '/setup')}
            >
              {t('Full setup guide ')}
              <Icon name="arrow" size={16} />
            </a>
          </div>
        </section>
        <section
          className={`${containerClassName} faq-section gap-[20px] grid grid-cols-[1fr] pt-[44px] pb-[70px] md:gap-[40px] md:grid-cols-[0.8fr_1.2fr] md:pt-[70px] md:pb-[100px] lg:gap-[80px]`}
        >
          <h2 className="text-[34px] md:text-[39px]">{t('Before you set out.')}</h2>
          <div className={`faq-list ${styles['faq-list']}`}>
            {faqs.map(([question, answer]) => (
              <details
                key={question}
                className="border-b-[1px] [border-bottom-style:solid] border-b-[var(--line)]"
              >
                <summary className="gap-[16px] px-0 py-[18px] list-none flex justify-between items-center cursor-pointer text-[13px] leading-[1.5]">
                  {question}
                  <Icon name="plus" size={17} />
                </summary>
                <p className="text-[12px] text-muted leading-[1.85] pt-0 pr-[24px] pb-[22px] pl-0">
                  {answer}
                </p>
              </details>
            ))}
          </div>
        </section>
        <section
          className={`${containerClassName} install-section px-0 text-center pt-[54px] pb-[70px] border-t-[1px] [border-top-style:solid] border-t-[var(--line)] md:pt-[70px] md:pb-[96px] ${styles['install-section']}`}
        >
          <Image src="/wisp.png" width={70} height={70} alt="" className="mb-[15px]" />
          <h2 className="text-[43px] mb-[28px] md:text-[52px]">
            {t('A little company.')}
            <br />
            {t('A better adventure.')}
          </h2>
          <InstallLink locale={locale} />
          <p className="download-note mt-[13px] block text-[11px] leading-[1.6] text-[#b8ad99]">
            {release && `v${release.version}`}
            {t(' · Windows x64 · Open source')}
          </p>
        </section>
      </main>
    </>
  );
}
