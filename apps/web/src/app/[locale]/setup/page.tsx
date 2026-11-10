import { containerClassName, link } from '../../../components/ui';
import { getTranslator } from '../../../i18n';
import { resolveLocale, type LocalePageProps } from '../../../i18n/server';
import { localizedMetadata } from '../../../seo';
import { Icon } from '../../../components/icon';
import { site } from '../../../site';
import { PageSchema } from '../../../components/page-schema';
export async function generateMetadata({ params }: LocalePageProps) {
  return localizedMetadata(await resolveLocale(params), '/setup');
}
export default async function Setup({ params }: LocalePageProps) {
  const locale = await resolveLocale(params);
  const t = getTranslator(locale);
  return (
    <>
      <main
        id="main"
        className={`${containerClassName} guide max-w-[790px] pt-[40px] pb-[80px] md:pt-[65px] [&_p:not(.guide-lead)]:text-[14px] [&_p:not(.guide-lead)]:leading-[1.9] [&_p:not(.guide-lead)]:text-muted [&_p:not(.guide-lead)]:mt-[12px] [&_strong_svg]:inline-block [&_strong_svg]:[vertical-align:-0.15em] [&_.connection-options_details:last-child]:border-b-[0] [&_.connection-options_details:last-child]:[border-bottom-style:none] [&_.connection-options_details:last-child]:border-b-[currentColor]`}
      >
        <PageSchema
          title={t('Get started')}
          description={t('Install Wisp for WoW: Forever on Windows and choose an AI connection.')}
          path="/setup"
          locale={locale}
        />
        <span className="eyebrow block text-[#a3906f] text-[9px] tracking-[2px] leading-[1.8] mb-[16px]">
          {t('YOUR FIRST ADVENTURE WITH WISP')}
        </span>
        <h1 className="text-[clamp(42px,_6vw,_64px)] leading-[1.08] tracking-[-2px]">
          {t('Let\u2019s get you in game.')}
        </h1>
        <p className="guide-lead mx-0 text-muted text-[16px] leading-[1.8] mt-[22px] mb-[26px] max-w-[570px]">
          {t('You’ll need Windows, WoW: Forever and your choice of AI connection.')}
        </p>
        <a className={link({ intent: 'primary' })} href={site.download}>
          <Icon name="windows" size={17} />
          {t('Download for Windows')}
          <Icon name="download" size={17} />
        </a>
        <ol
          className={`guide-steps p-0 mx-0 mt-[58px] mb-0 list-none [counter-reset:setup] [&_li]:[counter-increment:setup] [&_li::before]:[content:'0'_counter(setup)] [&_li::before]:absolute [&_li::before]:left-[0] [&_li::before]:top-[3px] [&_li::before]:text-gold [&_li::before]:text-[22px] [&_li::before]:[font-family:Georgia,_serif] [&_li::before]:font-normal [&_li::before]:not-italic [&_li::before]:[line-height:normal]`}
        >
          <li className="relative pt-0 pr-0 pb-[35px] pl-[39px] md:pl-[55px]">
            <h2 className="text-[28px] tracking-[-0.5px] mb-[17px]">
              {t('Install the app and addon')}
            </h2>
            <p>
              {t('Run the Windows installer and open Wisp. In ')}
              <strong className="text-[#dfd4c0] font-medium">{t('Overview')}</strong>
              {t(', select the WoW folder containing ')}
              <code className="text-gold text-[0.95em]">{t('Wow.exe')}</code>
              {t(', then install or update the addon.')}
            </p>
          </li>
          <li className="relative pt-0 pr-0 pb-[35px] pl-[39px] md:pl-[55px]">
            <h2 className="text-[28px] tracking-[-0.5px] mb-[17px]">
              {t('Connect an AI provider')}
            </h2>
            <p>
              {t('Open Connections in the desktop app and choose the option that works for you.')}
            </p>
            <div
              className={`connection-options border border-solid border-line px-[17px] mt-[20px] rounded-[5px] [&_summary::-webkit-details-marker]:hidden [&_summary_svg]:shrink-[0] [&_summary_svg]:text-[#ae9564] [&_details[open]_summary_svg]:[transform:rotate(45deg)]`}
              id="ai-connection"
            >
              <details className="px-0 py-[14px] border-b-[1px] [border-bottom-style:solid] border-b-[var(--line)]">
                <summary className="gap-[16px] cursor-pointer text-[14px] leading-[1.6] flex items-center justify-between list-none text-[#ded1ba]">
                  {t('ChatGPT subscription')}
                  <Icon name="plus" size={15} />
                </summary>
                <p>
                  {t(
                    'Sign in with Continue with ChatGPT and finish authorization in your browser. This option does not require an API key.',
                  )}
                </p>
              </details>
              <details className="px-0 py-[14px] border-b-[1px] [border-bottom-style:solid] border-b-[var(--line)]">
                <summary className="gap-[16px] cursor-pointer text-[14px] leading-[1.6] flex items-center justify-between list-none text-[#ded1ba]">
                  {t('API provider')}
                  <Icon name="plus" size={15} />
                </summary>
                <p>
                  {t(
                    'Choose Add connection and select a provider, such as Anthropic, Google, OpenAI or OpenRouter. Enter your API key and load the model list, or add a model by its exact ID.',
                  )}
                </p>
                <p>
                  {t(
                    'Test first model sends a small tool-calling check that may incur provider charges. Save the connection, select a Default model and click Set default. You can choose another configured model in each chat.',
                  )}
                </p>
              </details>
              <details className="px-0 py-[14px] border-b-[1px] [border-bottom-style:solid] border-b-[var(--line)]">
                <summary className="gap-[16px] cursor-pointer text-[14px] leading-[1.6] flex items-center justify-between list-none text-[#ded1ba]">
                  {t('Compatible or local server')}
                  <Icon name="plus" size={15} />
                </summary>
                <p>
                  {t(
                    'Choose OpenAI compatible / Local and enter the server’s base URL and model ID. A local server may not need an API key.',
                  )}
                </p>
              </details>
            </div>
            <p>
              {t(
                'For API or local connections, choose a model with tool calling and set its context window in tokens. Discovery fills this when available; for local models, use the server’s allocated context.',
              )}
            </p>
            <p>
              {t(
                'Choose a Default model and click Set default. You can choose another configured model in each chat.',
              )}
            </p>
            <p className="connection-note text-[12px] text-[#9d9380]">
              {t(
                'API usage is billed separately by the provider. Available tools, model discovery and reasoning controls vary by connection and model.',
              )}
            </p>
          </li>
          <li className="relative pt-0 pr-0 pb-[35px] pl-[39px] md:pl-[55px]">
            <h2 className="text-[28px] tracking-[-0.5px] mb-[17px]">{t('Restart WoW')}</h2>
            <p>
              {t('Fully exit and reopen the game. Enable ')}
              <strong className="text-[#dfd4c0] font-medium">{t('Wisp AI')}</strong>
              {t(' and its helper addons in the character selection screen’s ')}
              <strong className="text-[#dfd4c0] font-medium">{t('AddOns')}</strong>
              {t(' list.')}
            </p>
          </li>
          <li className="relative pt-0 pr-0 pb-[35px] pl-[39px] md:pl-[55px]">
            <h2 className="text-[28px] tracking-[-0.5px] mb-[17px]">{t('Say hello')}</h2>
            <p>
              {t('Log in and type ')}
              <code className="text-gold text-[0.95em]">{t('/wisp')}</code>
              {t('. Try asking')}{' '}
              <strong className="text-[#dfd4c0] font-medium">
                {t('\u201CWhich piece of my gear should I upgrade first?\u201D')}
              </strong>
              {t(' and follow up with your goals or budget.')}
            </p>
            <p>
              {t(
                'Keep the desktop app running. Closing its window leaves it in the Windows system tray; choosing ',
              )}
              <strong className="text-[#dfd4c0] font-medium">{t('Exit Wisp')}</strong>
              {t(' stops the connection.')}
            </p>
          </li>
        </ol>
        <section className="guide-extra mx-0 border-t-[1px] [border-top-style:solid] border-t-[var(--line)] pt-[32px] mt-[5px] mb-[36px] [scroll-margin-top:0]">
          <h2 className="text-[28px] tracking-[-0.5px] mb-[17px]">
            {t('Ask about what\u2019s under your cursor.')}
          </h2>
          <p>
            {t('In Wisp\u2019s in-game settings, choose ')}
            <strong className="text-[#dfd4c0] font-medium">{t('Bind inline chat')}</strong>
            {t(
              ' and assign an unused shortcut. Hover an item, spell or unit and press it to ask Wisp in context. You can also Shift-click supported items and spells into chat.',
            )}
          </p>
        </section>
        <section className="guide-extra mx-0 border-t-[1px] [border-top-style:solid] border-t-[var(--line)] pt-[32px] mt-[5px] mb-[36px] [scroll-margin-top:0]">
          <h2 className="text-[28px] tracking-[-0.5px] mb-[17px]">
            {t('Something not connecting?')}
          </h2>
          <details className="px-0 py-[17px] border-b-[1px] [border-bottom-style:solid] border-b-[var(--line)]">
            <summary className="cursor-pointer text-[14px] leading-[1.6]">
              {t('The addon isn\u2019t showing up.')}
            </summary>
            <p>
              {t('Check that you selected the folder containing ')}
              <code className="text-gold text-[0.95em]">{t('Wow.exe')}</code>
              {t(
                ', install/update the addon from Overview, then fully restart WoW and check the AddOns list.',
              )}
            </p>
          </details>
          <details className="px-0 py-[17px] border-b-[1px] [border-bottom-style:solid] border-b-[var(--line)]">
            <summary className="cursor-pointer text-[14px] leading-[1.6]">
              {t('Wisp is disconnected or stops replying.')}
            </summary>
            <p>
              {t('Keep the desktop app running. Check its Diagnostics page and type')}{' '}
              <code className="text-gold text-[0.95em]">{t('/wisp diag')}</code>
              {t(' in game. Try ')}
              <code className="text-gold text-[0.95em]">{t('/wisp reconnect')}</code>
              {t(' for a fresh handshake, or ')}
              <code className="text-gold text-[0.95em]">{t('/reload')}</code>
              {t(' to renew receive channels. Large replies can take several seconds.')}
            </p>
          </details>
          <details className="px-0 py-[17px] border-b-[1px] [border-bottom-style:solid] border-b-[var(--line)]">
            <summary className="cursor-pointer text-[14px] leading-[1.6]">
              {t('Sign-in or models are unavailable.')}
            </summary>
            <p>
              {t(
                'Check your selected connection in Connections and refresh the model list. For ChatGPT, finish browser sign-in or reconnect. For API connections, check your key, endpoint, model ID and context window, then use Test first model.',
              )}
            </p>
          </details>
        </section>
        <section
          className="guide-extra mx-0 border-t-[1px] [border-top-style:solid] border-t-[var(--line)] pt-[32px] mt-[5px] mb-[36px] [scroll-margin-top:0]"
          id="privacy"
        >
          <h2 className="text-[28px] tracking-[-0.5px] mb-[17px]">
            {t('Your controls and data.')}
          </h2>
          <p>
            {t(
              'Messages, relevant character readings and conversation context go to the AI connection you choose, including any gateway it uses. Enabled external sources receive lookup arguments. Conversations and preferences are stored locally. Data handling depends on your provider or endpoint.',
            )}
          </p>
          <p>
            {t('Control optional sources and tools in')}{' '}
            <strong className="text-[#dfd4c0] font-medium">
              {t('Settings ')}
              <Icon name="chevron-right" size={13} />
              {t(' Integrations')}
            </strong>
            {t('. View, edit or forget saved notes in ')}
            <strong className="text-[#dfd4c0] font-medium">{t('Memory')}</strong>
            {t('. Deleting a chat does not delete saved memory.')}
          </p>
          <p>
            {t(
              'You control movement, combat and trading. Wisp can create new macros, place verified map markers and apply supported settings changes when requested. It does not execute macros or place them on your action bar.',
            )}
          </p>
        </section>
      </main>
    </>
  );
}
