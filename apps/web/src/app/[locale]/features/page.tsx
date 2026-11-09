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
    <main id="main" className="feature-reference site-container">
      <PageSchema
        title={t('Features')}
        description="Explore Wisp’s capabilities, example prompts, requirements and limits."
        path="/features"
        locale={locale}
      />
      <div className="reference-intro">
        <span className="eyebrow">{t('WHAT WISP CAN DO')}</span>
        <h1>
          {t('A question.')}
          <br />
          {t('A useful next step.')}
        </h1>
        <p>
          {t(
            'Explore the things you can ask Wisp to help with, from a one-off macro to a routine that remembers your plan.',
          )}
        </p>
        <Link className="text-link" href={localizedPath(locale, '/setup')}>
          {t('Get started with Wisp ')}
          <Icon name="arrow" size={16} />
        </Link>
      </div>
      <div className="reference-layout">
        <aside className="reference-index">
          <FeatureIndex
            features={features.map(({ id, title, status }) => ({ id, title, status }))}
            locale={locale}
          />
        </aside>
        <div className="reference-articles">
          {features.map((feature) => (
            <section
              id={feature.id}
              className="reference-feature"
              key={feature.id}
              aria-labelledby={`${feature.id}-title`}
            >
              <div className="reference-feature-heading">
                {feature.icon === 'chat' ? (
                  <span className="item-icon chat-feature-icon" aria-hidden="true">
                    <Icon name="chat" size={26} />
                  </span>
                ) : (
                  <Item icon={feature.icon} name={feature.title} />
                )}
                <h2 id={`${feature.id}-title`}>{feature.title}</h2>
                {feature.status && <span className="beta-label">{feature.status}</span>}
              </div>
              <p>{feature.description}</p>
              <blockquote>
                <span>{feature.id === 'ai-connections' ? t('SETUP') : t('TRY ASKING')}</span>
                <p>
                  {feature.id === 'ai-connections' ? feature.example : <>“{feature.example}”</>}
                </p>
              </blockquote>
              <details>
                <summary>
                  {t('Requirements & things to know')}
                  <Icon name="plus" size={15} />
                </summary>
                <p>{feature.note}</p>
              </details>
              {feature.id === 'ai-connections' && (
                <Link
                  className="text-link connection-guide-link"
                  href={localizedPath(locale, '/setup#ai-connection')}
                >
                  {t('Connection setup guide')}
                  <Icon name="arrow" size={15} />
                </Link>
              )}
            </section>
          ))}
          <div className="reference-end">
            <h2>{t('Bring your next question in game.')}</h2>
            <Link className="button primary" href={localizedPath(locale, '/setup')}>
              {t('Set up Wisp ')}
              <Icon name="arrow" size={16} />
            </Link>
            <Link className="text-link" href={localizedPath(locale, '/setup#privacy')}>
              {t('Your controls & privacy ')}
              <Icon name="chevron-right" size={14} />
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
