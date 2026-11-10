'use client';
import { getTranslator, type Locale } from '../i18n';
import { useEffect, useRef, useState } from 'react';
type FeatureLink = {
  id: string;
  title: string;
  status?: string;
};
export function FeatureIndex({ features, locale }: { features: FeatureLink[]; locale: Locale }) {
  const t = getTranslator(locale);
  const [active, setActive] = useState<string | undefined>(features[0]?.id);
  const navigation = useRef<HTMLElement>(null);
  useEffect(() => {
    const sections = features
      .map(({ id }) => document.getElementById(id))
      .filter((section): section is HTMLElement => section !== null);
    let frame = 0;
    const update = () => {
      frame = 0;
      const readingLine = Math.min(160, window.innerHeight * 0.25);
      let current: string | undefined = sections[0]?.id;
      for (const section of sections) {
        if (section.getBoundingClientRect().top > readingLine) {
          break;
        }
        current = section.id;
      }
      if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2) {
        current = sections.at(-1)?.id;
      }
      setActive(current);
    };
    const schedule = () => {
      if (!frame) {
        frame = requestAnimationFrame(update);
      }
    };
    const observer = new ResizeObserver(schedule);
    sections.forEach((section) => observer.observe(section));
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('hashchange', schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('hashchange', schedule);
    };
  }, [features]);
  useEffect(() => {
    const nav = navigation.current;
    const link = nav?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!nav || !link || nav.scrollHeight <= nav.clientHeight) {
      return;
    }
    const parent = nav.getBoundingClientRect();
    const item = link.getBoundingClientRect();
    if (item.top < parent.top || item.bottom > parent.bottom) {
      nav.scrollTop += item.top - parent.top - (parent.height - item.height) / 2;
    }
  }, [active]);
  return (
    <nav
      className="flex max-h-none flex-row flex-wrap gap-x-[18px] gap-y-[9px] overflow-visible border-x-0 border-y border-solid border-line py-5 [scrollbar-color:#88734b55_transparent] [scrollbar-width:thin] md:max-h-[calc(100dvh_-_140px)] md:flex-col md:flex-nowrap md:gap-[3px] md:overflow-y-auto md:border-y-0 md:border-l md:py-0 md:pl-[18px]"
      aria-label={t('Feature index')}
      ref={navigation}
    >
      <span className="mb-[7px] w-full text-[8px] tracking-[1.5px] text-[#9f8e6e] md:mb-[15px] md:w-auto">
        {t('EXPLORE FEATURES')}
      </span>
      {features.map((feature) => (
        <a
          className="flex flex-wrap items-center gap-[5px] rounded-r-[3px] px-[7px] py-[3px] text-[11px] leading-[1.5] text-[#aaa192] transition-[color,background,box-shadow] duration-[180ms] hover:text-gold aria-[current=location]:bg-[#c7a96d0c] aria-[current=location]:text-gold aria-[current=location]:shadow-[inset_2px_0_0_#c7a96d] md:px-[10px] md:py-[7px] md:text-[12px]"
          key={feature.id}
          href={`#${feature.id}`}
          aria-current={active === feature.id ? 'location' : undefined}
        >
          {feature.title}
          {feature.status && <small className="text-[8px] text-[#a18a5e]">{feature.status}</small>}
        </a>
      ))}
    </nav>
  );
}
