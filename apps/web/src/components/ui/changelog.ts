import { tv } from 'tailwind-variants';
import { containerClassName } from '../ui';

export const changelogStyles = tv({
  slots: {
    page: `${containerClassName} pt-10 pb-16 md:pt-[65px] md:pb-20`,
    intro: 'mb-11 max-w-[650px]',
    eyebrow: 'mb-4 block text-[9px] leading-[1.8] tracking-[2px] text-[#a3906f]',
    heading: 'text-[clamp(46px,_5.2vw,_68px)] leading-[1.12] tracking-[-2px]',
    lead: 'my-[22px] max-w-[560px] text-sm leading-[1.8] text-muted md:text-base',
    tabs: 'flex gap-7 border-b [border-bottom-style:solid] border-line',
    tab: '-mb-px border-b [border-bottom-style:solid] border-transparent py-[14px] text-[13px] text-muted transition-[color,border-color] duration-[180ms] hover:border-gold hover:text-gold aria-[current=page]:border-gold aria-[current=page]:text-gold',
    notice: 'mt-7 text-sm leading-[1.8] text-muted',
    entry:
      'release-entry grid grid-cols-1 gap-6 border-b [border-bottom-style:solid] border-line py-9 md:grid-cols-[180px_minmax(0,1fr)] md:gap-10 md:py-14 lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-20',
    stamp:
      'flex flex-wrap items-center gap-[10px] text-[13px] [overflow-wrap:anywhere] md:flex-col md:items-start',
    channel: 'mb-1 text-[10px] tracking-[1.6px] text-gold uppercase',
    date: 'text-muted',
    title: 'mb-6 text-[clamp(28px,_3vw,_36px)] leading-[1.2] tracking-[-1px]',
    titleLink:
      'group transition-colors duration-[180ms] hover:text-gold hover:underline hover:decoration-1 hover:underline-offset-[6px] focus-visible:text-gold focus-visible:underline focus-visible:underline-offset-[6px]',
    titleArrow:
      'ml-[14px] inline-block align-baseline text-gold transition-transform duration-[180ms] group-hover:translate-x-1',
    prose:
      'max-w-[680px] text-[15px] leading-[1.8] text-muted [overflow-wrap:anywhere] [&_h2]:mt-7 [&_h2]:mb-[10px] [&_h2]:font-body [&_h2]:text-[17px] [&_h2]:font-medium [&_h2]:tracking-normal [&_h2]:text-foreground [&_h3]:mt-7 [&_h3]:mb-[10px] [&_h3]:font-body [&_h3]:text-[17px] [&_h3]:font-medium [&_h3]:tracking-normal [&_h3]:text-foreground [&_p+p]:mt-[18px] [&_ul+p]:mt-[18px] [&_p+ul]:mt-[18px] [&_a]:text-gold [&_a]:underline [&_a]:underline-offset-[3px] [&_li]:my-2 [&_img]:my-4 [&_img]:h-auto [&_img]:w-full [&_img]:rounded [&_img]:border [&_img]:border-solid [&_img]:border-line [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-[#0003] [&_pre]:p-4',
    links: 'mt-8 flex flex-wrap items-center gap-6',
    download:
      'min-h-11 gap-3 bg-[#d6b77708] px-[18px] text-[13px] font-medium hover:bg-[#d6b77714] md:min-h-11 [&_svg]:text-gold',
    textLink: 'inline-flex items-center gap-[9px] text-xs text-gold hover:text-gold',
    backLink: 'mb-8',
    empty: 'max-w-[620px] pt-14 pb-[72px]',
    emptyHeading: 'font-body text-xl leading-[1.4] font-medium tracking-[-0.3px]',
    emptyCopy: 'mt-3 mb-6 max-w-[480px] text-[15px] leading-[1.8] text-muted',
    pagination: 'mt-8 flex items-center justify-between gap-6',
    pageNumber: 'text-xs text-muted',
  },
});
