import { getTranslator, translateData, type Locale } from '../i18n';
import Image from 'next/image';
import { Icon } from './icon';
export function Item({
  icon,
  name,
  rarity = '',
  count,
}: {
  icon: string;
  name: string;
  rarity?: string;
  count?: number;
}) {
  const asset = icon === 'vest' ? 'vest-fur' : icon === 'feather' ? 'feather-light' : icon;
  return (
    <span
      className={`item-icon border border-solid border-[#96886c] w-[56px] h-[56px] inline-block relative rounded-[4px] shrink-0 overflow-hidden [vertical-align:middle] [box-shadow:inset_0_0_0_2px_#000,_0_3px_8px_#0006] [background:#171714] [&.uncommon]:border-[#62983e] [&.rare]:border-[#4b86be] ${rarity}`}
      title={name}
    >
      <Image
        src={`/items/${asset}.jpg`}
        width={56}
        height={56}
        alt={name}
        className="p-[2px] w-full h-full object-cover block rounded-[4px]"
      />
      {count && (
        <span
          className={`item-count absolute bottom-[1px] right-[3px] text-[16px] [font-family:Georgia,_serif] font-normal not-italic [line-height:normal] text-[#fff] [text-shadow:1px_1px_2px_#000,_-1px_-1px_#000]`}
        >
          {count}
        </span>
      )}
    </span>
  );
}
export function Money({
  silver,
  copper,
  locale = 'en',
}: {
  silver: number;
  copper?: number;
  locale?: Locale;
}) {
  const t = getTranslator(locale);
  return (
    <span className="money gap-[3px] inline-flex items-center whitespace-nowrap text-[12px] [font-variant-numeric:tabular-nums] text-[#e5d5ab]">
      {silver}
      <i
        className={`coin silver border border-solid border-[#ffffff30] inline-block w-[10px] h-[10px] rounded-[50%] mr-[3px] [box-shadow:inset_1px_1px_2px_#ffffff70,_1px_1px_2px_#0009] [background:linear-gradient(135deg,_#f1f1e8,_#7f8687)]`}
        role="img"
        aria-label={t('silver')}
      />
      {copper !== undefined && (
        <>
          {copper}
          <i
            className={`coin copper border border-solid border-[#ffffff30] inline-block w-[10px] h-[10px] rounded-[50%] mr-[3px] [box-shadow:inset_1px_1px_2px_#ffffff70,_1px_1px_2px_#0009] [background:linear-gradient(135deg,_#e7ac6e,_#98603a)]`}
            role="img"
            aria-label={t('copper')}
          />
        </>
      )}
    </span>
  );
}
export function GearVisual({ locale }: { locale: Locale }) {
  const t = getTranslator(locale);
  return (
    <div
      className={`gear-visual h-[320px] relative w-[min(390px,_100%)] justify-self-center mt-[5px] overflow-clip [overflow-clip-margin:12px] md:h-[330px] md:w-auto md:justify-self-auto md:mt-0 md:overflow-visible md:[overflow-clip-margin:0px] [filter:drop-shadow(0_12px_18px_#0004)] [&:before]:[content:''] [&:before]:absolute [&:before]:top-[-20px] [&:before]:right-[-20px] [&:before]:bottom-[-20px] [&:before]:left-[-20px] [&:before]:[background:radial-gradient(ellipse,_#a97c3a16,_transparent_68%)] [&:before]:z-[-1] max-md:[:lang(es)_&_.item-tooltip]:w-[210px] max-sm:[:lang(es)_&_.item-tooltip]:w-[195px]`}
    >
      <div
        className={`floating-items gap-[6px] absolute left-[12px] top-[15px] flex items-center md:left-[0] md:top-[28px] lg:gap-[15px] lg:left-[12px] [transform:rotate(-8deg)] [&_.item-icon]:w-[76px] [&_.item-icon]:h-[76px] max-lg:[&_.item-icon]:w-[64px] max-lg:[&_.item-icon]:h-[64px] max-md:[&_.item-icon]:w-[70px] max-md:[&_.item-icon]:h-[70px] max-sm:[&_.item-icon]:w-[63px] max-sm:[&_.item-icon]:h-[63px] [&_.item-icon:nth-child(2)]:[transform:translateY(-15px)] [&_.item-icon:nth-child(2)]:[box-shadow:0_0_24px_#7fbb3c20] [&_.item-icon:last-child]:[transform:rotate(13deg)]`}
      >
        <Item name={t('Cloth robe')} icon="robe" rarity="rare" />
        <Item name={t('Barbaric Linen Vest')} icon="vest" rarity="uncommon" />
        <Item name={t('Staff')} icon="staff" rarity="uncommon" />
      </div>
      <div
        className={`item-tooltip border border-solid border-[#8c8a97] px-[16px] py-[15px] absolute right-[0] top-[60px] w-[185px] rounded-[5px] [font-family:Arial,_sans-serif] text-[13px] leading-[1.55] z-[2] sm:w-[198px] md:right-[-5px] md:top-[66px] md:w-[190px] lg:right-[0] lg:w-[205px] [background:linear-gradient(120deg,_#111120f5,_#080a14)] [box-shadow:0_0_0_2px_#04050a,_0_10px_30px_#0008]`}
      >
        <strong className="uncommon text-[#69c64d] text-[15px] font-normal block mb-[7px]">
          {t('Barbaric Linen Vest')}
        </strong>
        <span className="block">
          {t('Chest ')}
          <span className="[float:right]">{t('Cloth')}</span>
        </span>
        <span className="block">{t('+2 Stamina')}</span>
        <span className="block">{t('+2 Spell Power')}</span>
        <small className="text-[#aaa9b1] block mt-[5px] text-[12px]">
          {t('Requires Level 12')}
        </small>
      </div>
      <div
        className={`auction-list border border-solid border-[#8e79554d] p-[6px] absolute bottom-[0] left-[0] w-[310px] rounded-[4px] z-[3] max-w-full md:w-[305px] md:max-w-none lg:left-[20px] lg:w-[330px] [background:#1b1a16] [box-shadow:0_8px_30px_#0006] [&_>_div_.money]:ml-auto [&_>_div_.money]:text-[11px] [&_.item-icon]:w-[29px] [&_.item-icon]:h-[29px] max-md:[:lang(es)_&_>_div]:gap-[6px] max-md:[:lang(es)_&_>_div]:text-[9px]`}
      >
        <div className="gap-[9px] px-[6px] py-[5px] flex items-center border-b-[1px] [border-bottom-style:solid] border-b-[#bfa77817] text-[11px]">
          <Item name={t('Barbaric Linen Vest')} icon="vest" rarity="uncommon" />
          <span className="uncommon text-[#69c64d]">{t('Barbaric Linen Vest')}</span>
          <Money silver={3} locale={locale} />
        </div>
        <div className="gap-[9px] px-[6px] py-[5px] flex items-center border-b-[1px] [border-bottom-style:solid] border-b-[#bfa77817] text-[11px]">
          <Item name={t('Barbaric Linen Vest')} icon="vest" rarity="uncommon" />
          <span className="uncommon text-[#69c64d]">{t('Barbaric Linen Vest')}</span>
          <Money silver={3} copper={50} locale={locale} />
        </div>
        <small className="px-[6px] text-[8px] text-[#827969] block pt-[7px] pb-[2px]">
          {t('Example loaded listings')}
        </small>
      </div>
    </div>
  );
}
const baseBagItems: [string, string, number][] = [
  ['linen', 'Linen Cloth', 20],
  ['linen', 'Linen Cloth', 20],
  ['feather', 'Light Feather', 6],
  ['ore', 'Copper Ore', 10],
  ['meat', 'Boar Meat', 1],
  ['potion', 'Healing Potion', 5],
  ['book', 'Spellbook', 1],
];
export function BagsVisual({ locale }: { locale: Locale }) {
  const t = getTranslator(locale);
  const bagItems = translateData(baseBagItems, locale);
  return (
    <div
      className={`bags-visual h-[365px] relative max-w-[420px] w-[min(390px,_100%)] justify-self-center mt-[8px] overflow-clip [overflow-clip-margin:12px] sm:h-[385px] md:h-[390px] md:w-full md:mt-0 md:overflow-visible md:[overflow-clip-margin:0px] [&:before]:[content:''] [&:before]:absolute [&:before]:top-[-20px] [&:before]:right-[-20px] [&:before]:bottom-[-20px] [&:before]:left-[-20px] [&:before]:[background:radial-gradient(ellipse,_#a97c3a16,_transparent_68%)] [&:before]:z-[-1]`}
    >
      <div
        className={`inventory border border-solid border-[#9b8054] p-[10px] absolute right-[0] top-[0] rounded-[6px] w-[250px] sm:p-[12px] sm:right-[15px] sm:w-[272px] [background:linear-gradient(135deg,_#353024,_#181914)] [box-shadow:0_0_0_3px_#242016,_0_16px_40px_#0008] [transform:rotate(3deg)]`}
      >
        <div className="inventory-heading px-[1px] text-[16px] [font-family:Georgia,_serif] font-normal not-italic [line-height:normal] border-b-[1px] [border-bottom-style:solid] border-b-[#a58b5840] pt-0 pb-[10px] mb-[10px] flex justify-between">
          {t('Backpack ')}
          <span className="text-[9px] font-body font-normal not-italic [line-height:normal] text-[#a49372] self-center">
            {t('16 slots')}
          </span>
        </div>
        <div
          className={`inventory-grid gap-[6px] grid grid-cols-[repeat(4,_1fr)] [&_.item-icon]:w-[55px] [&_.item-icon]:h-[55px] max-sm:[&_.item-icon]:w-[50px] max-sm:[&_.item-icon]:h-[50px]`}
        >
          {Array.from({ length: 16 }, (_, i) =>
            bagItems[i] ? (
              <Item key={i} icon={bagItems[i][0]} name={bagItems[i][1]} count={bagItems[i][2]} />
            ) : (
              <span
                key={i}
                className={`empty-slot border border-solid border-[#7d6d493e] w-[50px] h-[50px] rounded-[3px] sm:w-[55px] sm:h-[55px] [background:#100f0c88] [box-shadow:inset_1px_2px_8px_#0006]`}
              />
            ),
          )}
        </div>
        <div className="inventory-gold text-right mt-[10px]">
          <Money silver={14} copper={63} locale={locale} />
        </div>
      </div>
      <div
        className={`macro-toast gap-[12px] border border-solid border-[#8c79554d] p-[10px] absolute left-[0] bottom-[82px] z-[2] flex rounded-[5px] sm:py-[12px] sm:bottom-[90px] sm:pr-[18px] sm:pl-[12px] [background:#22231df5] [box-shadow:0_12px_30px_#0006] [transform:rotate(-3deg)] [&_.item-icon]:w-[42px] [&_.item-icon]:h-[42px] [&_small_svg]:inline-block [&_small_svg]:[vertical-align:-0.15em]`}
      >
        <Item icon="wand" name={t('Wand Shot')} rarity="rare" />
        <div>
          <small className="text-[#8dc872] block text-[11px] mb-[7px]">
            <Icon name="check" size={12} />
            {t(' Macro created')}
          </small>
          <code className="text-[13px] text-[#e5dac4]">{t('/cast !Shoot')}</code>
        </div>
      </div>
      <div
        className={`action-bar gap-[6px] border border-solid border-[#89764c] p-[9px] absolute bottom-[8px] left-[0] flex rounded-[5px] sm:left-[32px] [background:linear-gradient(#4a4333,_#24231d)] [box-shadow:0_8px_18px_#0008] [transform:rotate(-2deg)] [&_.item-icon]:w-[49px] [&_.item-icon]:h-[49px] max-sm:[&_.item-icon]:w-[44px] max-sm:[&_.item-icon]:h-[44px] [&_kbd]:[text-shadow:1px_1px_#000]`}
      >
        {['frost', 'wand', 'fire', 'potion', 'book'].map((icon, i) => (
          <span
            key={icon}
            className={
              i === 1
                ? `selected-action rounded-[4px] relative [outline:1px_solid_#e5bd64] [outline-offset:2px] [box-shadow:0_0_15px_#c6a14a70]`
                : ``
            }
          >
            <Item
              icon={icon}
              name={
                [
                  t('Frostbolt'),
                  t('Wand Shot'),
                  t('Fireball'),
                  t('Healing Potion'),
                  t('Spellbook'),
                ][i]
              }
            />
            <kbd className="absolute top-[2px] right-[4px] text-[10px] [font-family:Arial] font-normal not-italic [line-height:normal] text-[white]">
              {i + 1}
            </kbd>
          </span>
        ))}
      </div>
    </div>
  );
}
