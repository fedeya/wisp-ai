'use client';
import { PlaybackButton } from './ui/playback-button';

import { getTranslator, type Locale } from '../i18n';
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { useSceneMotion } from './use-scene-motion';
import { Icon } from './icon';
import { Item } from './game-ui';
const baseAdvice =
  'Your guide’s next step: learn your new spell ranks, then continue the quest route.';
const baseFollowup = 'And which talents should I take according to the guide?';
const baseTalentAdvice =
  'Let’s compare your build with the guide’s talent order before you spend the next point.';
const holds: Record<number, number> = {
  2: 650,
  3: 650,
  4: 200,
  5: 2600,
  6: 1000,
  7: 200,
  8: 5500,
  9: 500,
};
export function RoutineScene({ locale }: { locale: Locale }) {
  const t = getTranslator(locale);
  const advice = t(baseAdvice);
  const followup = t(baseFollowup);
  const talentAdvice = t(baseTalentAdvice);
  const [step, setStep] = useState(2);
  const [letters, setLetters] = useState(0);
  const [inView, setInView] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(true);
  const activeText = step === 7 ? talentAdvice : advice;
  const finishedWriting = letters >= activeText.length;
  const stopped = reduced || paused || !inView || !visible;
  const [section, animate, write] = useSceneMotion(stopped, reduced);
  const progress = useRef(0);
  useEffect(() => {
    progress.current = letters;
  }, [letters]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const motion = () => setReduced(media.matches);
    const visibility = () => setVisible(!document.hidden);
    motion();
    visibility();
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), {
      threshold: 0.25,
    });
    if (section.current) {
      observer.observe(section.current);
    }
    media.addEventListener('change', motion);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      observer.disconnect();
      media.removeEventListener('change', motion);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [section]);
  useEffect(() => {
    if (!inView || reduced || paused || !visible || ([4, 7].includes(step) && !finishedWriting)) {
      return;
    }
    const timer = setTimeout(() => {
      const next = step === 9 ? 2 : step + 1;
      if ([2, 4, 7].includes(next)) {
        setLetters(0);
      }
      setStep(next);
    }, holds[step]);
    return () => clearTimeout(timer);
  }, [step, finishedWriting, inView, reduced, paused, visible]);
  useEffect(() => {
    if (![4, 7].includes(step) || reduced) {
      return;
    }
    const from = Math.min(progress.current, activeText.length);
    return write(from, activeText.length, ((activeText.length - from) / 4) * 0.044, (value) =>
      setLetters(Math.floor(value)),
    );
  }, [write, step, activeText, reduced]);
  const shown = reduced ? 5 : step;
  const complete = reduced || step > 4 || (step === 4 && finishedWriting);
  const reached = shown >= 3;
  const replyVisible = shown >= 4 && shown < 6;
  const fading = step === 9 && !reduced;
  useEffect(() => {
    const stops = [
      animate(
        '.level-event',
        {
          opacity: reached ? 1 : 0.2,
          transform: reached ? 'translateY(0px)' : 'translateY(5px)',
        },
        { duration: 0.7 },
      ),
    ];
    stops.push(
      animate(
        '.level-medallion',
        {
          boxShadow:
            reached && !reduced
              ? ['0 0 0 #d6af5000', '0 0 32px #d6af5055', '0 0 16px #d6af5010']
              : 'none',
        },
        { duration: 1.3 },
      ),
    );
    stops.push(
      animate(
        '.level-rays',
        {
          opacity: reached && !reduced ? [0, 1, 0] : 0,
          transform: reached && !reduced ? ['scale(0.5)', 'scale(1)', 'scale(1.8)'] : 'none',
        },
        { duration: 1.4 },
      ),
    );
    return () => stops.forEach((stop) => stop());
  }, [animate, reached, reduced]);
  useEffect(
    () =>
      animate(
        '.routine-feed',
        {
          opacity: fading ? 0 : 1,
          transform: fading ? 'translateY(-7px)' : 'none',
        },
        { duration: 0.5 },
      ),
    [animate, fading],
  );
  useEffect(
    () =>
      animate(
        '.routine-reply',
        {
          opacity: replyVisible ? 1 : 0,
          transform: replyVisible ? 'translateY(0px)' : 'translateY(10px)',
        },
        { duration: 0.6 },
      ),
    [animate, replyVisible],
  );
  useEffect(
    () =>
      animate(
        '.routine-next-actions',
        {
          opacity: complete ? 1 : 0,
          transform: complete ? 'translateY(0px)' : 'translateY(5px)',
        },
        { duration: 0.5 },
      ),
    [animate, complete],
  );
  useEffect(() => {
    const stops: Array<() => void> = [];
    if (shown === 2) {
      for (const [index, selector] of ['path:first-child', 'path:last-child'].entries()) {
        stops.push(
          animate(
            '.routine-connection ' + selector,
            {
              opacity: [0.2, 1, 0.5],
              transform: ['translateX(-3px)', 'translateX(0px)'],
            },
            { duration: 0.5, delay: index * 0.12 },
          ),
        );
      }
    }
    if (!reduced && shown === 6) {
      stops.push(
        animate(
          '.routine-followup-scene',
          {
            opacity: [0, 1],
            transform: ['translateY(7px)', 'translateY(0px)'],
          },
          { duration: 0.5 },
        ),
      );
    }
    if (!reduced && shown === 7) {
      stops.push(
        animate(
          '.routine-talent-answer',
          {
            opacity: [0, 1],
            transform: ['translateY(9px)', 'translateY(0px)'],
          },
          { duration: 0.4 },
        ),
      );
    }
    return () => stops.forEach((stop) => stop());
  }, [animate, shown, reduced]);
  return (
    <section
      className={`routine-section px-0 pt-[62px] pb-[50px] border-t-[1px] [border-top-style:solid] border-t-[var(--line)] md:pt-[88px] md:pb-[64px] ${stopped ? `routine-stopped [&_*]:[animation-play-state:paused] [&_*::after]:[animation-play-state:paused]` : ``}`}
      id="routines"
      aria-labelledby="routine-title"
      ref={section}
      data-step={shown}
    >
      <div
        className={`routine-heading gap-[45px] block items-end justify-between mb-[30px] md:flex md:mb-[43px] max-md:[:lang(es)_&_h2]:text-[41px] max-sm:[:lang(es)_&_h2]:text-[37px]`}
      >
        <div>
          <span className="eyebrow block text-[#a3906f] text-[9px] tracking-[2px] leading-[1.8] mb-[16px]">
            {t('MEMORY & ROUTINES')}
          </span>
          <h2
            id="routine-title"
            className="text-[43px] leading-[1.12] sm:text-[46px] lg:text-[54px]"
          >
            {t('Your plan.')}
            <br />
            <em>{t('Your next step.')}</em>
          </h2>
        </div>
        <p className="max-w-[340px] text-[14px] leading-[1.8] text-muted pb-[4px] mt-[20px] md:text-[15px] md:mt-0">
          {t('Wisp remembers the guide you follow and checks what\u2019s next when you level up.')}
        </p>
      </div>
      <div
        className={`routine-story border border-solid border-[#c4a67125] px-[15px] py-[25px] grid grid-cols-[1fr] items-start rounded-[8px] sm:px-[20px] md:px-[22px] md:py-[28px] md:grid-cols-[minmax(0,_1fr)_90px_minmax(0,_1fr)] md:relative lg:px-[38px] lg:py-[35px] lg:grid-cols-[minmax(0,_1fr)_120px_minmax(0,_1fr)] [background:radial-gradient(ellipse_at_85%_20%,_#bd893515,_transparent_55%),_linear-gradient(130deg,_#211f191f,_#1b19143b)]`}
        aria-live="off"
      >
        <div className="routine-instruction">
          <span className="routine-moment block text-[#a19071] text-[8px] tracking-[1.7px] mb-[19px] md:mb-[23px]">
            {t('SET IT UP ONCE')}
          </span>
          <div
            className={`saved-guide gap-[13px] flex items-center [&_.item-icon]:w-[46px] [&_.item-icon]:h-[46px] [&_.item-icon]:[transform:rotate(-5deg)]`}
          >
            <Item icon="book" name={t('Saved leveling guide')} />
            <div className="flex-[1]">
              <small className="block text-[#8f836c] text-[8px] tracking-[1.1px] mb-[6px]">
                {t('YOUR SAVED GUIDE')}
              </small>
              <strong className="block text-[21px] [font-family:Georgia,_serif] font-normal not-italic [line-height:normal] text-[#e5dac5]">
                {t('My leveling plan')}
              </strong>
              <span className="block text-[10px] text-[#8f887b] mt-[6px]">
                {t('One adventure. A little direction.')}
              </span>
            </div>
          </div>
          <p className="routine-prompt text-[15px] leading-[1.75] text-[#e0d7c5] mt-[25px] max-w-[360px] md:text-[16px]">
            {t(
              '\u201CFollow this guide. Whenever I level up, tell me what I should do next.\u201D',
            )}
          </p>
          <div
            className={`routine-confirmations gap-[7px] flex flex-wrap mt-[23px] min-h-[28px] sm:gap-[9px] [&_>_span]:[transition:opacity_500ms,_background_500ms,_border-color_500ms] [&_>_.confirmed]:border-[#819b5c45] [&_>_.confirmed]:opacity-[1] [&_>_.confirmed]:[background:#8dba4a08] [&_svg]:text-[#9db579] [:lang(es)_&_>_span]:text-[8px]`}
          >
            <span
              className={
                shown >= 1
                  ? `confirmed gap-[6px] border border-solid border-[#a2947020] px-[9px] py-[7px] inline-flex items-center text-[9px] rounded-[4px] opacity-[0.28] text-[#c3b796]`
                  : ``
              }
            >
              <Icon name="check" size={13} />
              {t('Guide remembered')}
            </span>
            <span
              className={
                shown >= 2
                  ? `confirmed gap-[6px] border border-solid border-[#a2947020] px-[9px] py-[7px] inline-flex items-center text-[9px] rounded-[4px] opacity-[0.28] text-[#c3b796]`
                  : ``
              }
            >
              <Icon name="repeat" size={13} />
              {t('Level-up routine active')}
            </span>
          </div>
        </div>
        <div
          className={`routine-connection gap-[0] p-0 mx-0 my-[16px] grid items-center justify-center text-[#bea06a] opacity-[0.25] h-[42px] flex-col grid-cols-[1fr] w-[42px] justify-self-center grid-rows-[42px] content-center [place-items:center] md:my-0 md:grid-cols-[20px] md:absolute md:left-[calc(50%_-_max(0px,_(100%_-_918px)_/_4))] md:top-[50%] md:flex-row md:grid-rows-none md:content-normal [transition:opacity_800ms] [transform:translate(-50%,_-50%)] max-md:[transform:revert-layer] [&.connected]:opacity-[1] max-md:[&_svg]:[transform:rotate(90deg)] max-md:[&_>_svg]:[transform:rotate(90deg)] ${shown >= 2 ? `connected` : ``}`}
          aria-hidden="true"
        >
          <svg
            width="42"
            height="42"
            viewBox="0 0 42 42"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="justify-self-center block"
          >
            <path d="m10 12 9 9-9 9" className="opacity-[0.5]" />
            <path d="m22 12 9 9-9 9" className="opacity-[0.5]" />
          </svg>
        </div>
        <div className="routine-outcome min-w-[0] md:col-[3]">
          <span className="routine-moment block text-[#a19071] text-[8px] tracking-[1.7px] mb-[18px]">
            {t('THEN, WHILE YOU PLAY')}
          </span>
          <div
            className={`level-event gap-[14px] relative flex items-center mb-[16px] opacity-[0.2] [transform:translateY(5px)]`}
          >
            <div
              className={`level-medallion border border-solid border-[#ad8f4f] w-[54px] h-[54px] flex justify-center items-center rounded-[50%] text-[27px] [font-family:Georgia,_serif] font-normal not-italic [line-height:normal] text-[#ead497] shrink-0 [outline:1px_solid_#b99b4f26] [outline-offset:4px] [background:radial-gradient(circle,_#765b232e,_#1e1b15_75%)] [text-shadow:0_0_15px_#e9b94740]`}
            >
              20
            </div>
            <div>
              <span className="mb-[6px] block text-[9px] tracking-[2px] text-[#be9b57]">
                {t('LEVEL UP')}
              </span>
              <strong className="text-[19px] [font-family:Georgia,_serif] font-normal not-italic [line-height:normal] text-[#e8d7b0] md:text-[20px]">
                {t('You\u2019ve reached level 20.')}
              </strong>
            </div>
            <div
              className={`level-rays absolute left-[-16px] top-[-16px] w-[86px] h-[86px] rounded-[50%] pointer-events-none opacity-[0] [background:radial-gradient(circle,_#d6af5040,_transparent_68%)]`}
              aria-hidden="true"
            />
          </div>
          <div
            className={`routine-feed h-[260px] relative overflow-clip [overflow-anchor:none] [overscroll-behavior:auto] sm:h-[240px] md:h-[225px] lg:h-[190px] max-lg:[:lang(es)_&]:h-[255px] max-md:[:lang(es)_&]:h-[290px] max-sm:[:lang(es)_&]:h-[325px]`}
          >
            <div
              className={`routine-reply border border-solid border-[#b7a17832] p-[16px] rounded-[6px] min-h-[0] opacity-[0] absolute top-[0] right-[0] bottom-[auto] left-[0] [background:linear-gradient(130deg,_#28271ff0,_#1c1c18)] [transform:translateY(10px)]`}
              aria-hidden={shown < 4 || shown >= 6}
            >
              <div
                className={`routine-reply-heading gap-[7px] flex items-center mb-[14px] [:lang(es)_&_>_span]:text-[7px]`}
              >
                <Image src="/wisp.png" alt="" width={24} height={24} />
                <strong className="text-[13px] font-medium">{t(' Wisp')}</strong>
                <span className="ml-auto text-[7px] text-[#a89c83] hidden sm:inline md:text-[8px]">
                  {t('Your level-up check-in')}
                </span>
              </div>
              <p className="streaming-text grid text-[12px] text-[#c7bfae] leading-[1.8]">
                <span
                  className="streaming-measure [visibility:hidden] pointer-events-none [grid-area:1_/_1]"
                  aria-hidden="true"
                >
                  {advice}
                </span>
                <span className="[grid-area:1_/_1]">
                  {reduced || step > 4 ? advice : advice.slice(0, letters)}
                  {!complete && (
                    <span
                      className={`writing-caret inline-block w-[1px] h-[1em] ml-[2px] [vertical-align:-0.12em] [background:#d6b777] animate-caret`}
                    />
                  )}
                </span>
              </p>
              <div
                className={`routine-next-actions gap-[10px] grid grid-cols-[1fr] border-t-[1px] [border-top-style:solid] border-t-[#d5bd8e15] pt-[13px] mt-[15px] opacity-[0] sm:grid-cols-[1fr_1fr] md:grid-cols-[1fr] lg:grid-cols-[1fr_1fr] [transform:translateY(5px)] [&_.item-icon]:w-[28px] [&_.item-icon]:h-[28px]`}
              >
                <div className="gap-[7px] flex items-center text-[10px] leading-[1.5] text-[#c5b797]">
                  <Item icon="frost" name={t('Spell upgrades')} />
                  <span>{t('Review spell upgrades')}</span>
                </div>
                <div className="gap-[7px] flex items-center text-[10px] leading-[1.5] text-[#c5b797]">
                  <Item icon="book" name={t('Quest route')} />
                  <span>{t('Continue your quest route')}</span>
                </div>
              </div>
            </div>
            {!reduced && step >= 6 && (
              <div className="routine-followup-scene absolute top-[0] right-[0] bottom-[auto] left-[0]">
                <p
                  className={`routine-followup border border-solid border-[#b49c702a] px-[13px] py-[11px] mt-0 mr-0 mb-[10px] ml-[30px] text-[#e2d8c6] text-[12px] leading-[1.7] rounded-[6px_6px_2px_6px] [background:#b49c7020]`}
                >
                  {followup}
                </p>
                {!reduced && step >= 7 && (
                  <div
                    className={`routine-talent-answer border border-solid border-[#b7a17832] p-[16px] rounded-[6px] [background:#24251e]`}
                  >
                    <div
                      className={`routine-reply-heading gap-[7px] flex items-center mb-[14px] [:lang(es)_&_>_span]:text-[7px]`}
                    >
                      <Image src="/wisp.png" alt="" width={24} height={24} />
                      <strong className="text-[13px] font-medium">{t(' Wisp')}</strong>
                      <span className="ml-auto text-[7px] text-[#a89c83] hidden sm:inline md:text-[8px]">
                        {t('Using your saved guide')}
                      </span>
                    </div>
                    <p className="streaming-text grid text-[#c7bfae] text-[12px] leading-[1.8]">
                      <span
                        className="streaming-measure [visibility:hidden] pointer-events-none [grid-area:1_/_1]"
                        aria-hidden="true"
                      >
                        {talentAdvice}
                      </span>
                      <span className="[grid-area:1_/_1]">
                        {step === 7 ? talentAdvice.slice(0, letters) : talentAdvice}
                        {step === 7 && !finishedWriting && (
                          <span
                            className={`writing-caret inline-block w-[1px] h-[1em] ml-[2px] [vertical-align:-0.12em] [background:#d6b777] animate-caret`}
                          />
                        )}
                      </span>
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <div
        className={`routine-bottom gap-[20px] px-[3px] flex items-center justify-between pt-[17px] pb-0`}
      >
        <span className="text-[#8d8370] text-[9px] leading-[1.6] max-w-[185px] sm:max-w-[245px] md:text-[10px] md:max-w-none">
          {t('Keep your plan in memory. Let a routine bring it back at the right time.')}
        </span>
        <PlaybackButton
          scene="routine"
          paused={paused || reduced}
          type="button"
          onClick={() => {
            if (reduced) {
              setStep(2);
              setLetters(0);
              setReduced(false);
              setPaused(false);
            } else {
              setPaused(!paused);
            }
          }}
          aria-label={paused || reduced ? t('Play routine example') : t('Pause routine example')}
        >
          {paused || reduced ? t('Play') : t('Pause')}
        </PlaybackButton>
      </div>
    </section>
  );
}
