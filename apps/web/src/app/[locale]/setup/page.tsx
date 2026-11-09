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
      <main id="main" className="guide container">
        <PageSchema
          title={t('Get started')}
          description={t('Install Wisp for WoW: Forever on Windows and choose an AI connection.')}
          path="/setup"
          locale={locale}
        />
        <span className="eyebrow">{t('YOUR FIRST ADVENTURE WITH WISP')}</span>
        <h1>{t('Let\u2019s get you in game.')}</h1>
        <p className="guide-lead">
          {t('You’ll need Windows, WoW: Forever and your choice of AI connection.')}
        </p>
        <a
          className="button primary"
          href={site.download}
          data-rybbit-event="download_clicked"
          data-rybbit-prop-source="setup"
        >
          <Icon name="windows" size={17} />
          {t('Download for Windows')}
          <Icon name="download" size={17} />
        </a>
        <ol className="guide-steps">
          <li>
            <h2>{t('Install the app and addon')}</h2>
            <p>
              {t('Run the Windows installer and open Wisp. In ')}
              <strong>{t('Overview')}</strong>
              {t(', select the WoW folder containing ')}
              <code>{t('Wow.exe')}</code>
              {t(', then install or update the addon.')}
            </p>
          </li>
          <li>
            <h2>{t('Connect an AI provider')}</h2>
            <p>
              {t('Open Connections in the desktop app and choose the option that works for you.')}
            </p>
            <div className="connection-options" id="ai-connection">
              <details>
                <summary>
                  {t('ChatGPT subscription')}
                  <Icon name="plus" size={15} />
                </summary>
                <p>
                  {t(
                    'Sign in with Continue with ChatGPT and finish authorization in your browser. This option does not require an API key.',
                  )}
                </p>
              </details>
              <details>
                <summary>
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
              <details>
                <summary>
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
            <p className="connection-note">
              {t(
                'API usage is billed separately by the provider. Available tools, model discovery and reasoning controls vary by connection and model.',
              )}
            </p>
          </li>
          <li>
            <h2>{t('Restart WoW')}</h2>
            <p>
              {t('Fully exit and reopen the game. Enable ')}
              <strong>{t('Wisp AI')}</strong>
              {t(' and its helper addons in the character selection screen’s ')}
              <strong>{t('AddOns')}</strong>
              {t(' list.')}
            </p>
          </li>
          <li>
            <h2>{t('Say hello')}</h2>
            <p>
              {t('Log in and type ')}
              <code>{t('/wisp')}</code>
              {t('. Try asking')}{' '}
              <strong>{t('\u201CWhich piece of my gear should I upgrade first?\u201D')}</strong>
              {t(' and follow up with your goals or budget.')}
            </p>
            <p>
              {t(
                'Keep the desktop app running. Closing its window leaves it in the Windows system tray; choosing ',
              )}
              <strong>{t('Exit Wisp')}</strong>
              {t(' stops the connection.')}
            </p>
          </li>
        </ol>
        <section className="guide-extra">
          <h2>{t('Ask about what\u2019s under your cursor.')}</h2>
          <p>
            {t('In Wisp\u2019s in-game settings, choose ')}
            <strong>{t('Bind inline chat')}</strong>
            {t(
              ' and assign an unused shortcut. Hover an item, spell or unit and press it to ask Wisp in context. You can also Shift-click supported items and spells into chat.',
            )}
          </p>
        </section>
        <section className="guide-extra">
          <h2>{t('Something not connecting?')}</h2>
          <details>
            <summary>{t('The addon isn\u2019t showing up.')}</summary>
            <p>
              {t('Check that you selected the folder containing ')}
              <code>{t('Wow.exe')}</code>
              {t(
                ', install/update the addon from Overview, then fully restart WoW and check the AddOns list.',
              )}
            </p>
          </details>
          <details>
            <summary>{t('Wisp is disconnected or stops replying.')}</summary>
            <p>
              {t('Keep the desktop app running. Check its Diagnostics page and type')}{' '}
              <code>{t('/wisp diag')}</code>
              {t(' in game. Try ')}
              <code>{t('/wisp reconnect')}</code>
              {t(' for a fresh handshake, or ')}
              <code>{t('/reload')}</code>
              {t(' to renew receive channels. Large replies can take several seconds.')}
            </p>
          </details>
          <details>
            <summary>{t('Sign-in or models are unavailable.')}</summary>
            <p>
              {t(
                'Check your selected connection in Connections and refresh the model list. For ChatGPT, finish browser sign-in or reconnect. For API connections, check your key, endpoint, model ID and context window, then use Test first model.',
              )}
            </p>
          </details>
        </section>
        <section className="guide-extra" id="privacy">
          <h2>{t('Your controls and data.')}</h2>
          <p>
            {t(
              'Messages, relevant character readings and conversation context go to the AI connection you choose, including any gateway it uses. Enabled external sources receive lookup arguments. Conversations and preferences are stored locally. Data handling depends on your provider or endpoint.',
            )}
          </p>
          <p>
            {t('Control optional sources and tools in')}{' '}
            <strong>
              {t('Settings ')}
              <Icon name="chevron-right" size={13} />
              {t(' Integrations')}
            </strong>
            {t('. View, edit or forget saved notes in ')}
            <strong>{t('Memory')}</strong>
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
