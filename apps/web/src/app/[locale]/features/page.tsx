import { containerClassName } from '../../../components/ui';
import sharedStyles from '../../../components/shared.module.css';
import styles from './page.module.css';
import { getTranslator, translateData, localizedPath } from '../../../i18n';
import { resolveLocale, type LocalePageProps } from '../../../i18n/server';
import { localizedMetadata } from '../../../seo';
import Link from 'next/link';
import { Item } from '../../../components/game-ui';
import { Icon } from '../../../components/icon';
import { FeatureIndex } from '../../../components/feature-index';
import { PageSchema } from '../../../components/page-schema';
const baseFeatures = [
  {
    id: 'routines',
    icon: 'book',
    title: 'Routines',
    description:
      'Ask Wisp to check in when something changes, so you don’t have to remember to ask again. Continue the conversation from a useful check-in.',
    example:
      'Whenever I level up, tell me what I should do next according to the guide I’m following.',
    note: 'Runs while your character and the desktop app are connected. Supports events such as level, gear, bags and quest changes, or intervals of at least one minute. Automatic runs are read-only; combat or an active conversation can delay them.',
  },
  {
    id: 'memory',
    icon: 'book',
    title: 'Memory & saved plans',
    description:
      'Keep your preferences, goals and guide notes available for future conversations and routines. Build on your plan without explaining it from scratch.',
    example:
      'Remember this guide and the build I’m following for the next time I ask you for advice.',
    note: 'Memory is optional. View, edit or forget notes in Memory. Saved plans are separate from live character readings; deleting a chat does not delete saved memory.',
  },
  {
    id: 'gear',
    icon: 'vest',
    title: 'Gear & upgrades',
    description:
      'Find the slots worth replacing and compare alternatives with your current equipment, level and priorities. Follow up with your budget or where you want to get the item.',
    example: 'Which piece of my gear should I replace first, and what should I replace it with?',
    note: 'Uses your connected character’s equipment and available item references. Stat comparisons are not full damage simulations or a guarantee of the optimal build.',
  },
  {
    id: 'auctions',
    icon: 'ring',
    title: 'Auction prices & your budget',
    description:
      'Put an upgrade in context: weigh available prices against your gold, compare alternatives and decide whether to buy now or keep saving.',
    example:
      'With the available auction prices and the gold I have, which of those upgrades is worth it?',
    note: 'Uses enabled Auctionator last-seen prices, existing loaded results while the auction house is open, or available market references. Coverage and freshness vary. Wisp does not search or scan the auction house, buy or sell.',
  },
  {
    id: 'macros',
    icon: 'wand',
    title: 'Macro creation',
    description:
      'Describe what you want and ask Wisp to create a new macro using the spells your character knows.',
    example: 'Create a wand macro that won’t stop shooting when I press it again.',
    note: 'Creates new macros outside combat. Review the code and place the macro on your bar yourself. Wisp cannot overwrite, run or assign macros to action bars.',
  },
  {
    id: 'bags',
    icon: 'linen',
    title: 'Bags & professions',
    description:
      'Find out what your materials are used for and decide what to keep, craft or sell based on your professions and plans.',
    example: 'Of everything in my bags, what should I keep for my professions and what can I sell?',
    note: 'Reads bags and professions from your connected character, then uses available item and crafting references. Learned recipes and source coverage matter. Crafting and selling remain with you.',
  },
  {
    id: 'quests',
    icon: 'staff',
    title: 'Quests, trainers & map markers',
    description:
      'Look up quest chains, rewards, NPCs and trainers. Turn a verified destination into a map marker and keep planning from there.',
    example: 'With the quests I have, which route should I take? Mark where to start on my map.',
    note: 'Location coverage depends on available Forever references and providers such as Questie. Requested pins use validated coordinates. Undo preserves pins you changed yourself; Wisp does not move your character.',
  },
  {
    id: 'wow-chat',
    icon: 'chat',
    title: 'Read your WoW chat',
    description:
      'Ask Wisp what your party said or who is looking for a group. Choose which chats it can read, including individual public channels such as /1 and /3.',
    example: 'Is anyone in /1 or /3 looking for a healer?',
    note: 'Choose channels in Settings / WoW chat history. Public channels and whispers start disabled. Wisp keeps up to 200 messages for 30 minutes in memory, starting at login or reload, and consults them when needed. Retrieved messages are shared with your selected AI provider. You can clear the buffer at any time.',
  },
  {
    id: 'hover',
    icon: 'feather',
    title: 'Ask under your cursor',
    description:
      'Ask about an item, spell or unit without opening a full chat first. Keep asking follow-ups or expand the exchange into a full conversation.',
    example: 'What is this used for? Should I keep it?',
    note: 'Set Bind inline chat in Wisp’s in-game settings, then hover a supported reference and press the shortcut. You can also Shift-click supported items and spells into chat.',
  },
  {
    id: 'settings',
    icon: 'robe',
    title: 'Settings changes',
    description:
      'Ask about supported game or addon settings, preview a change, apply it when ready and undo it if needed.',
    example:
      'Turn on auto-loot and enemy nameplates. Show me a preview before applying the changes.',
    note: 'Supports selected game settings and registered AceConfig options. Availability depends on the option and combat state. Action bars and keybindings are read-only; arbitrary addon settings are not guaranteed to be supported.',
  },
  {
    id: 'panels',
    icon: 'ore',
    title: 'Panels & trackers',
    status: 'Beta',
    description:
      'Save a character panel to keep materials, gold or progress in view. Local readings can update as you play without a model call for each change.',
    example: 'Create a tracker for 20 Linen Cloth and 1 gold so I can see what I’m missing.',
    note: 'Saved panels persist across chats and reloads for that character. Restore hidden panels with Show saved panels or from the desktop Panels page. This feature is in beta.',
  },
  {
    id: 'simulation',
    icon: 'frost',
    title: 'Combat simulation',
    status: 'Experimental',
    description:
      'Compare supported combat setups and scenarios with an experimental simulator. Use the results as another input when thinking through a build.',
    example:
      'Simulate my current gear against this upgrade in a 30-second fight. How much damage do I gain?',
    note: 'Class, spell and scenario coverage is limited and expanding. This is not yet a complete simulator, a live combat reading or a universal gear optimizer.',
  },
  {
    id: 'ai-connections',
    icon: 'frost',
    title: 'AI connections & models',
    description:
      'Use ChatGPT through your subscription, connect an API provider such as Claude, Gemini or OpenRouter, or choose a compatible local server. Pick a configured model for each conversation.',
    example: 'Connections / Add connection / Default model',
    note: 'Choose a tool-calling model and configure its context window for API connections. API usage is billed by the provider; local servers must be running. Model capabilities vary.',
  },
  {
    id: 'connections',
    icon: 'book',
    title: 'Addons, knowledge & custom tools',
    description:
      'Bring optional sources together: Questie for locations, Auctionator for cached prices, Syndicator for inventory context and Forever databases for references. Add your own tools through MCP.',
    example: 'Check what I have on my other characters before I buy more crafting materials.',
    note: 'Optional sources must be enabled and available. Control integrations and individual tools in Settings / Integrations. Custom MCP connections have their own access and data behavior.',
  },
];
export async function generateMetadata({ params }: LocalePageProps) {
  return localizedMetadata(await resolveLocale(params), '/features');
}
export default async function Features({ params }: LocalePageProps) {
  const locale = await resolveLocale(params);
  const t = getTranslator(locale);
  const features = translateData(baseFeatures, locale);
  return (
    <main
      id="main"
      className={`${containerClassName} feature-reference pt-[40px] pb-[55px] md:pt-[65px] md:pb-[80px]`}
    >
      <PageSchema
        title={t('Features')}
        description="Explore Wisp’s capabilities, example prompts, requirements and limits."
        path="/features"
        locale={locale}
      />
      <div className="reference-intro max-w-[650px] mb-[35px] md:mb-[60px]">
        <span className="eyebrow block text-[#a3906f] text-[9px] tracking-[2px] leading-[1.8] mb-[16px]">
          {t('WHAT WISP CAN DO')}
        </span>
        <h1 className="text-[clamp(46px,_5.2vw,_68px)] leading-[1.12] tracking-[-2px]">
          {t('A question.')}
          <br />
          {t('A useful next step.')}
        </h1>
        <p className="mx-0 my-[22px] text-muted text-[14px] leading-[1.8] max-w-[560px] md:text-[16px]">
          {t(
            'Explore the things you can ask Wisp to help with, from a one-off macro to a routine that remembers your plan.',
          )}
        </p>
        <Link
          className={`text-link gap-[9px] inline-flex items-center text-gold text-[12px] ${sharedStyles['text-link']}`}
          href={localizedPath(locale, '/setup')}
        >
          {t('Get started with Wisp ')}
          <Icon name="arrow" size={16} />
        </Link>
      </div>
      <div className="reference-layout gap-[35px] grid grid-cols-[1fr] items-start md:gap-[40px] md:grid-cols-[200px_minmax(0,_1fr)] lg:gap-[80px] lg:grid-cols-[240px_minmax(0,_1fr)]">
        <aside className={`reference-index static top-[110px] md:sticky`}>
          <FeatureIndex
            features={features.map(({ id, title, status }) => ({ id, title, status }))}
            locale={locale}
          />
        </aside>
        <div className="reference-articles">
          {features.map((feature) => (
            <section
              id={feature.id}
              className={`reference-feature px-0 pt-[28px] pb-[32px] border-t-[1px] [border-top-style:solid] border-t-[var(--line)] [scroll-margin-top:0] md:pt-[32px] md:pb-[36px] ${styles['reference-feature']}`}
              key={feature.id}
              aria-labelledby={`${feature.id}-title`}
            >
              <div
                className={`reference-feature-heading gap-[10px] flex items-center mb-[17px] flex-wrap md:gap-[13px] md:flex-nowrap ${styles['reference-feature-heading']}`}
              >
                {feature.icon === 'chat' ? (
                  <span
                    className={`item-icon chat-feature-icon border border-solid border-[#96886c] w-[38px] h-[38px] inline-flex relative rounded-[4px] shrink-0 overflow-hidden [vertical-align:middle] items-center justify-center text-[#d5bb75] ${sharedStyles['item-icon']}`}
                    aria-hidden="true"
                  >
                    <Icon name="chat" size={26} />
                  </span>
                ) : (
                  <Item icon={feature.icon} name={feature.title} />
                )}
                <h2
                  id={`${feature.id}-title`}
                  className="text-[25px] leading-[1.2] tracking-[-0.6px] flex-[1] min-w-[170px] md:text-[27px] md:flex-initial md:min-w-[auto] lg:text-[29px]"
                >
                  {feature.title}
                </h2>
                {feature.status && (
                  <span className="beta-label border border-solid border-[#bba16b3a] px-[7px] py-[5px] text-[8px] tracking-[1px] text-[#b7a17c] rounded-[3px] self-[center] justify-self-[start] ml-[48px] uppercase shrink-0 md:ml-auto md:justify-self-auto">
                    {feature.status}
                  </span>
                )}
              </div>
              <p className="text-muted text-[13px] leading-[1.9] max-w-[730px] md:text-[14px]">
                {feature.description}
              </p>
              <blockquote className="px-[18px] py-[15px] mx-0 mt-[21px] mb-[19px] border-l-[2px] [border-left-style:solid] border-l-[#b89c604d]">
                <span className="block text-[#a1906f] text-[8px] tracking-[1.3px] mb-[8px]">
                  {feature.id === 'ai-connections' ? t('SETUP') : t('TRY ASKING')}
                </span>
                <p className="text-[#d9cbae] text-[13px] leading-[1.8] md:text-[14px]">
                  {feature.id === 'ai-connections' ? feature.example : <>“{feature.example}”</>}
                </p>
              </blockquote>
              <details>
                <summary className="gap-[12px] py-[6px] inline-flex items-center cursor-pointer text-[11px] leading-[1.7] text-[#a49a86] list-none">
                  {t('Requirements & things to know')}
                  <Icon name="plus" size={15} />
                </summary>
                <p className="text-[#9e9585] text-[11px] leading-[1.9] mt-[10px] max-w-[730px] md:text-[12px]">
                  {feature.note}
                </p>
              </details>
              {feature.id === 'ai-connections' && (
                <Link
                  className={`text-link connection-guide-link gap-[9px] inline-flex items-center text-gold text-[12px] mt-[14px] ${sharedStyles['text-link']}`}
                  href={localizedPath(locale, '/setup#ai-connection')}
                >
                  {t('Connection setup guide')}
                  <Icon name="arrow" size={15} />
                </Link>
              )}
            </section>
          ))}
          <div className="reference-end gap-[23px] border-t-[1px] [border-top-style:solid] border-t-[var(--line)] pt-[35px] mt-[8px] flex items-center flex-wrap">
            <h2 className="w-full text-[30px] leading-[1.2] mb-[3px] md:text-[33px]">
              {t('Bring your next question in game.')}
            </h2>
            <Link
              className={`button primary gap-[12px] border border-solid border-[#efdaab] px-[22px] py-0 inline-flex min-h-[48px] items-center justify-center rounded-[4px] text-[13px] font-semibold text-[#241c10] ${sharedStyles['button']} ${sharedStyles['primary']}`}
              href={localizedPath(locale, '/setup')}
            >
              {t('Set up Wisp ')}
              <Icon name="arrow" size={16} />
            </Link>
            <Link
              className={`text-link gap-[9px] inline-flex items-center text-gold text-[12px] ${sharedStyles['text-link']}`}
              href={localizedPath(locale, '/setup#privacy')}
            >
              {t('Your controls & privacy ')}
              <Icon name="chevron-right" size={14} />
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
