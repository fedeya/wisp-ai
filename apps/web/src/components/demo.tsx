'use client';

import { getTranslator, translateData, type Locale } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { Item, Money } from './game-ui';
import { Icon } from './icon';
import { useSceneMotion } from './use-scene-motion';
const baseScenes = [
  {
    prompt: 'Which piece of my gear should I upgrade first?',
    label: 'Equipment & prices',
    reply: 'I’d start with your chest. More survivability, and a little more damage.',
  },
  {
    prompt: 'Make a wand macro that won’t stop shooting when I press it again.',
    label: 'Macros & actions',
    reply:
      'Done. Repeated presses won’t toggle Shoot off. Place the macro on your action bar when you’re ready.',
  },
  {
    prompt: 'Look at my bags. What’s worth keeping for my professions?',
    label: 'Bags & professions',
    reply: 'You have Mining and Cooking. Here’s where I’d start:',
  },
];
const baseFollowupPrompt = 'Is it worth it with the gold I have?';
const baseFollowupReply =
  'At that price, I’d buy the vest and save the rest. Check the final price and quantity before buying.';
export function Demo({ locale }: { locale: Locale }) {
  const t = getTranslator(locale);
  const scenes = translateData(baseScenes, locale);
  const followupPrompt = t(baseFollowupPrompt);
  const followupReply = t(baseFollowupReply);
  const [scene, setScene] = useState(0);
  // write prompt, think, write reply, hold, write follow-up, think, write reply, hold, leave
  const [stage, setStage] = useState(0);
  const [characters, setCharacters] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [visible, setVisible] = useState(true);
  const [inView, setInView] = useState(false);
  const transcript = useRef<HTMLDivElement>(null);
  const progress = useRef(0);
  const current = scenes[scene];
  const typing = [0, 2, 4, 6].includes(stage);
  const text =
    stage === 0
      ? current.prompt
      : stage === 4
        ? followupPrompt
        : stage === 6
          ? followupReply
          : current.reply;
  const stopped = paused || reduced || !visible || !inView;
  const [container, animate, write] = useSceneMotion(stopped, reduced);
  const finishedWriting = characters >= text.length;
  useEffect(() => {
    progress.current = characters;
  }, [characters]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    const visibility = () => setVisible(!document.hidden);
    update();
    visibility();
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), {
      threshold: 0.05,
    });
    if (container.current) {
      observer.observe(container.current);
    }
    media.addEventListener('change', update);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      observer.disconnect();
      media.removeEventListener('change', update);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [container]);
  useEffect(() => {
    if (stopped || (typing && !finishedWriting)) {
      return;
    }
    const delay = typing
      ? 500
      : stage === 8
        ? 420
        : stage === 3
          ? 3000
          : stage === 7
            ? 6000
            : stage === 1 || stage === 5
              ? 1000
              : 500;
    const timer = window.setTimeout(() => {
      setCharacters(0);
      if (stage === 8) {
        setScene((scene + 1) % scenes.length);
        setStage(0);
      } else if (stage === 3 && scene !== 0) {
        setStage(7);
      } else {
        setStage(stage + 1);
      }
    }, delay);
    return () => {
      clearTimeout(timer);
    };
  }, [scene, stage, typing, finishedWriting, stopped]);
  useEffect(() => {
    if (!typing || reduced) {
      return;
    }
    const increment = stage === 0 || stage === 4 ? 2 : 4;
    const from = Math.min(progress.current, text.length);
    return write(from, text.length, ((text.length - from) / increment) * 0.04, (value) =>
      setCharacters(Math.floor(value)),
    );
  }, [write, scene, stage, typing, text, reduced]);
  useEffect(() => {
    const element = transcript.current;
    if (element) {
      if (stage === 0) {
        element.scrollTop = 0;
      } else {
        element.scrollTo({
          top: element.scrollHeight,
          behavior: reduced || [0, 2, 4, 6].includes(stage) ? 'instant' : 'smooth',
        });
      }
    }
  }, [stage, reduced]);
  const shownStage = reduced ? 3 : stage;
  const reply = reduced || stage > 2 ? current.reply : current.reply.slice(0, characters);
  const writingPrompt = !reduced && (stage === 0 || stage === 4);
  const waiting = shownStage === 1 || shownStage === 5;
  useEffect(() => {
    const stops = [
      animate(
        '.chat-thread',
        {
          opacity: stage === 8 && !reduced ? 0 : 1,
          transform: stage === 8 && !reduced ? 'translateY(-9px)' : 'none',
        },
        { duration: 0.42 },
      ),
    ];
    const enter = (selector: string) =>
      animate(
        selector,
        {
          opacity: [0, 1],
          transform: ['translateY(9px)', 'translateY(0px)'],
        },
        { duration: 0.4 },
      );
    if (shownStage === 1 || reduced) {
      stops.push(enter('[data-motion="question"]'));
    }
    if (shownStage === 2 || reduced) {
      stops.push(enter('[data-motion="answer"]'));
    }
    if (shownStage >= 2) {
      stops.push(
        animate(
          '[data-motion="result"]',
          {
            opacity: shownStage >= 3 ? 1 : 0,
            transform: shownStage >= 3 ? 'translateY(0px) scale(1)' : 'translateY(7px) scale(0.98)',
          },
          { duration: 0.55 },
        ),
      );
    }
    if (scene === 0 && shownStage === 5) {
      stops.push(enter('[data-motion="followup"]'));
    }
    if (scene === 0 && shownStage === 6) {
      stops.push(enter('[data-motion="followup-answer"]'));
    }
    if (waiting) {
      stops.push(enter('.thinking'));
    }
    return () => stops.forEach((stop) => stop());
  }, [animate, scene, stage, shownStage, reduced, waiting]);
  return (
    <div
      ref={container}
      className={`live-demo m-0 w-[min(370px,_100%)] relative z-[1] max-w-full md:w-[370px] ${stopped ? `demo-stopped [&_*]:[animation-play-state:paused] [&_*::after]:[animation-play-state:paused]` : ``}`}
      data-scene={scene}
      data-stage={shownStage}
    >
      <div
        className={`wisp-window border border-solid border-[#897c675e] rounded-[8px] overflow-hidden h-[431px] grid grid-rows-[42px_minmax(0,_1fr)_71px] [background:linear-gradient(135deg,_#25231ff7,_#1c1b19fa)] [box-shadow:0_18px_65px_#0008,_0_0_0_3px_#18181644]`}
      >
        <div
          className={`window-heading px-[15px] py-0 h-[42px] flex justify-between items-center border-b-[1px] [border-bottom-style:solid] border-b-[#c4ad8124] text-[#b5aa95] text-[15px] [background:#ffffff04] [&_>_span:first-child]:gap-[6px] [&_>_span:first-child]:flex [&_>_span:first-child]:items-center [&_>_span:first-child]:font-medium [&_>_span:first-child]:text-[#e2dbcc]`}
        >
          <span>
            <Image src="/wisp.png" width={23} height={23} alt="" />
            {t(' Wisp')}
          </span>
          <Icon name="minus" size={13} />
        </div>
        <div
          className={`chat-content p-[17px] min-h-[0] h-[auto] overflow-y-auto [overscroll-behavior:contain] [overflow-anchor:none] [scrollbar-width:thin] [scrollbar-color:#88734b55_transparent] [scrollbar-gutter:stable]`}
          ref={transcript}
          aria-live="off"
        >
          <div className="chat-thread min-h-full" key={scene}>
            {shownStage >= 1 && (
              <p
                className={`chat-question border border-solid border-[#c2b8a51b] px-[12px] py-[10px] rounded-[8px_8px_2px_8px] mt-0 mr-0 mb-[15px] ml-[24px] text-[12px] leading-[1.5] text-[#eee6d9] [background:#3b383266]`}
                data-motion="question"
              >
                {current.prompt}
              </p>
            )}
            {shownStage >= 2 && (
              <div
                className={`chat-answer text-[12px] leading-[1.65] text-[#c8c1b5] [&_>_p:not(.chat-question)]:mb-[12px] [&_pre]:[background:#10110f80]`}
                data-motion="answer"
              >
                <p className="streaming-text grid">
                  <span
                    className="streaming-measure [visibility:hidden] pointer-events-none [grid-area:1_/_1]"
                    aria-hidden="true"
                  >
                    {current.reply}
                  </span>
                  <span className="[grid-area:1_/_1]">
                    {reply}
                    {stage === 2 && !reduced && (
                      <span
                        className={`writing-caret inline-block w-[1px] h-[1em] ml-[2px] [vertical-align:-0.12em] [background:#d6b777] animate-caret`}
                      />
                    )}
                  </span>
                </p>
                {shownStage >= 2 && (
                  <div
                    data-motion="result"
                    className={shownStage >= 3 ? undefined : `result-pending [visibility:hidden]`}
                  >
                    {scene === 0 && (
                      <div
                        className={`chat-item gap-[11px] border border-solid border-[#a8a09220] p-[10px] mx-0 flex items-center rounded-[4px] mt-[10px] mb-[14px] [background:#12120f85] [&_.item-icon]:w-[37px] [&_.item-icon]:h-[37px] [&_small_svg]:inline-block [&_small_svg]:[vertical-align:-0.15em] [:lang(es)_&_b]:text-[11px]`}
                      >
                        <Item name={t('Barbaric Linen Vest')} icon="vest" rarity="uncommon" />
                        <div>
                          <b className="uncommon text-[#69c64d] font-medium text-[12px]">
                            {t('Barbaric Linen Vest')}
                          </b>
                          <small className="block text-[#a7a397] text-[10px] leading-[1.5] mt-[2px]">
                            {t('+2 Stamina \u00B7 +2 Spell Power')}
                          </small>
                        </div>
                      </div>
                    )}
                    {scene === 1 && (
                      <>
                        <div
                          className={`chat-item gap-[11px] border border-solid border-[#a8a09220] p-[10px] mx-0 flex items-center rounded-[4px] mt-[10px] mb-[14px] [background:#12120f85] [&_.item-icon]:w-[37px] [&_.item-icon]:h-[37px] [&_small_svg]:inline-block [&_small_svg]:[vertical-align:-0.15em] [:lang(es)_&_b]:text-[11px]`}
                        >
                          <Item name={t('Wand Shot')} icon="wand" rarity="rare" />
                          <div>
                            <b className="font-medium text-[12px]">{t('Wand Shot')}</b>
                            <small className="uncommon text-[#a7a397] block text-[10px] leading-[1.5] mt-[2px]">
                              <Icon name="check" size={12} />
                              {t(' New macro created')}
                            </small>
                          </div>
                        </div>
                        <pre className="border border-solid border-[#c5ad8222] p-[13px] mx-0 my-[12px] rounded-[4px] text-[12px] text-[#e7d7b8] leading-[1.8]">
                          <code>
                            {t('#showtooltip Shoot')}
                            {'\n'}
                            {t('/cast !Shoot')}
                          </code>
                        </pre>
                      </>
                    )}
                    {scene === 2 && (
                      <>
                        <div
                          className={`bag-advice gap-[10px] flex items-center mt-[13px] [&_.item-icon]:w-[34px] [&_.item-icon]:h-[34px] [&_.item-icon]:shrink-[0]`}
                        >
                          <Item name={t('Linen Cloth')} icon="linen" />
                          <p>
                            <b className="text-[11px] font-medium">{t('Linen Cloth')}</b>
                            <small className="block text-[#a7a397] text-[10px] leading-[1.5] mt-[2px]">
                              {t('Sell unless you\u2019re planning First Aid or Tailoring.')}
                            </small>
                          </p>
                        </div>
                        <div
                          className={`bag-advice gap-[10px] flex items-center mt-[13px] [&_.item-icon]:w-[34px] [&_.item-icon]:h-[34px] [&_.item-icon]:shrink-[0]`}
                        >
                          <Item name={t('Light Feather')} icon="feather" />
                          <p>
                            <b className="text-[11px] font-medium">{t('Light Feather')}</b>
                            <small className="block text-[#a7a397] text-[10px] leading-[1.5] mt-[2px]">
                              {t('Keep. It\u2019s a spell reagent.')}
                            </small>
                          </p>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
            {scene === 0 && shownStage >= 5 && (
              <p
                className={`chat-question followup border border-solid border-[#c2b8a51b] px-[12px] py-[10px] rounded-[8px_8px_2px_8px] mt-[14px] mr-0 mb-[15px] ml-[24px] text-[12px] leading-[1.5] text-[#eee6d9] [background:#3b383266]`}
                data-motion="followup"
              >
                {followupPrompt}
              </p>
            )}
            {scene === 0 && shownStage >= 6 && (
              <div
                className={`chat-answer text-[12px] leading-[1.65] text-[#c8c1b5] [&_>_p:not(.chat-question)]:mb-[12px] [&_pre]:[background:#10110f80]`}
                data-motion="followup-answer"
              >
                <div className="chat-prices gap-[15px] flex flex-wrap pb-[12px] text-[10px] text-[#a79d8b]">
                  <span className="gap-[6px] flex items-center">
                    {t('Loaded listing ')}
                    <Money silver={3} locale={locale} />
                  </span>
                  <span className="gap-[6px] flex items-center">
                    {t('Your gold ')}
                    <Money silver={14} copper={63} locale={locale} />
                  </span>
                </div>
                <p className="streaming-text grid">
                  <span
                    className="streaming-measure [visibility:hidden] pointer-events-none [grid-area:1_/_1]"
                    aria-hidden="true"
                  >
                    {followupReply}
                  </span>
                  <span className="[grid-area:1_/_1]">
                    {stage === 6 ? followupReply.slice(0, characters) : followupReply}
                    {stage === 6 && (
                      <span
                        className={`writing-caret inline-block w-[1px] h-[1em] ml-[2px] [vertical-align:-0.12em] [background:#d6b777] animate-caret`}
                      />
                    )}
                  </span>
                </p>
              </div>
            )}
            {waiting && (
              <div
                className={`thinking gap-[5px] px-0 flex items-center h-[31px] pt-[1px] pb-[5px] [&_>_span]:[background:#b6a180] [&_>_span]:animate-thinking [&_>_span:nth-of-type(2)]:[animation-delay:140ms] [&_>_span:nth-of-type(3)]:[animation-delay:280ms]`}
                aria-label={t('Wisp is thinking')}
              >
                <Image
                  src="/wisp.png"
                  width={18}
                  height={18}
                  alt=""
                  className="mr-[5px] opacity-[0.8]"
                />
                <span className="w-[4px] h-[4px] rounded-[50%]" />
                <span className="w-[4px] h-[4px] rounded-[50%]" />
                <span className="w-[4px] h-[4px] rounded-[50%]" />
              </div>
            )}
          </div>
        </div>
        <div
          className={`chat-composer gap-[12px] border border-solid border-[#baab8d28] p-[10px] mx-[12px] mt-0 mb-[12px] rounded-[4px] text-[#837d70] text-[11px] flex justify-between min-h-[0] items-center leading-[1.5] h-[59px] overflow-hidden [background:#12120e45] [&_>_span:first-child]:flex-[1] [&_>_span:first-child]:text-[#837d70] [&_>_span:first-child]:min-w-[0] ${writingPrompt ? `composer-writing [&_>_span:first-child]:text-[#ddd1bb]` : ``}`}
        >
          <span className="text-[#c7b78f]">
            {writingPrompt ? text.slice(0, characters) : t('Ask a follow-up\u2026')}
            {writingPrompt && (
              <span
                className={`writing-caret inline-block w-[1px] h-[1em] ml-[2px] [vertical-align:-0.12em] text-[#c7b78f] [background:#d6b777] animate-caret`}
              />
            )}
          </span>
          <Icon name="enter" size={13} />
        </div>
      </div>
      <div
        className={`demo-caption mx-[3px] flex justify-between items-center text-[#b8ad99] text-[10px] mt-[13px] mb-0 [&_i]:[background:var(--gold)] [&_i]:[box-shadow:0_0_8px_#d6b77780] [&_button]:[background:#1716137a] [&_button_svg]:shrink-[0]`}
      >
        <span className="gap-[7px] flex items-center">
          <i className="w-[5px] h-[5px] rounded-[50%]" />
          {current.label}
        </span>
        <button
          onClick={() => {
            setPaused(!(paused || reduced));
            setReduced(false);
          }}
          aria-label={paused || reduced ? t('Play demo') : t('Pause demo')}
          className="gap-[5px] border border-solid border-[#d8c5a52a] px-[9px] py-[6px] text-[#c3b79e] rounded-[3px] text-[10px] cursor-pointer min-h-[28px] inline-flex items-center"
        >
          <Icon name={paused || reduced ? 'play' : 'pause'} size={12} />
          {paused || reduced ? t('Play') : t('Pause')}
        </button>
      </div>
    </div>
  );
}
