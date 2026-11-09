import sharedStyles from './shared.module.css';
import styles from './game-ui.module.css';
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
      className={`item-icon border border-solid border-[#96886c] w-[56px] h-[56px] inline-block relative rounded-[4px] shrink-0 overflow-hidden [vertical-align:middle] ${sharedStyles['item-icon']} ${rarity}`}
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
          className={`item-count absolute bottom-[1px] right-[3px] text-[16px] [font-family:Georgia,_serif] font-normal not-italic [line-height:normal] text-[#fff] ${styles['item-count']}`}
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
        className={`coin silver border border-solid border-[#ffffff30] inline-block w-[10px] h-[10px] rounded-[50%] mr-[3px] ${styles['coin']} ${styles['silver']}`}
        role="img"
        aria-label={t('silver')}
      />
      {copper !== undefined && (
        <>
          {copper}
          <i
            className={`coin copper border border-solid border-[#ffffff30] inline-block w-[10px] h-[10px] rounded-[50%] mr-[3px] ${styles['coin']} ${styles['copper']}`}
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
      className={`gear-visual h-[320px] relative w-[min(390px,_100%)] justify-self-[center] mt-[5px] overflow-clip [overflow-clip-margin:12px] md:h-[330px] md:w-auto md:justify-self-auto md:mt-0 md:overflow-visible md:[overflow-clip-margin:0px] ${styles['gear-visual']}`}
    >
      <div
        className={`floating-items gap-[6px] absolute left-[12px] top-[15px] flex items-center md:left-[0] md:top-[28px] lg:gap-[15px] lg:left-[12px] ${styles['floating-items']}`}
      >
        <Item name={t('Cloth robe')} icon="robe" rarity="rare" />
        <Item name={t('Barbaric Linen Vest')} icon="vest" rarity="uncommon" />
        <Item name={t('Staff')} icon="staff" rarity="uncommon" />
      </div>
      <div
        className={`item-tooltip border border-solid border-[#8c8a97] px-[16px] py-[15px] absolute right-[0] top-[60px] w-[185px] rounded-[5px] [font-family:Arial,_sans-serif] text-[13px] leading-[1.55] z-[2] sm:w-[198px] md:right-[-5px] md:top-[66px] md:w-[190px] lg:right-[0] lg:w-[205px] ${styles['item-tooltip']}`}
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
        className={`auction-list border border-solid border-[#8e79554d] p-[6px] absolute bottom-[0] left-[0] w-[310px] rounded-[4px] z-[3] max-w-full md:w-[305px] md:max-w-none lg:left-[20px] lg:w-[330px] ${styles['auction-list']}`}
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
      className={`bags-visual h-[365px] relative max-w-[420px] w-[min(390px,_100%)] justify-self-[center] mt-[8px] overflow-clip [overflow-clip-margin:12px] sm:h-[385px] md:h-[390px] md:w-full md:mt-0 md:overflow-visible md:[overflow-clip-margin:0px] ${styles['bags-visual']}`}
    >
      <div
        className={`inventory border border-solid border-[#9b8054] p-[10px] absolute right-[0] top-[0] rounded-[6px] w-[250px] sm:p-[12px] sm:right-[15px] sm:w-[272px] ${styles['inventory']}`}
      >
        <div className="inventory-heading px-[1px] text-[16px] [font-family:Georgia,_serif] font-normal not-italic [line-height:normal] border-b-[1px] [border-bottom-style:solid] border-b-[#a58b5840] pt-0 pb-[10px] mb-[10px] flex justify-between">
          {t('Backpack ')}
          <span className="text-[9px] font-body font-normal not-italic [line-height:normal] text-[#a49372] self-[center]">
            {t('16 slots')}
          </span>
        </div>
        <div
          className={`inventory-grid gap-[6px] grid grid-cols-[repeat(4,_1fr)] ${styles['inventory-grid']}`}
        >
          {Array.from({ length: 16 }, (_, i) =>
            bagItems[i] ? (
              <Item key={i} icon={bagItems[i][0]} name={bagItems[i][1]} count={bagItems[i][2]} />
            ) : (
              <span
                key={i}
                className={`empty-slot border border-solid border-[#7d6d493e] w-[50px] h-[50px] rounded-[3px] sm:w-[55px] sm:h-[55px] ${styles['empty-slot']}`}
              />
            ),
          )}
        </div>
        <div className="inventory-gold text-right mt-[10px]">
          <Money silver={14} copper={63} locale={locale} />
        </div>
      </div>
      <div
        className={`macro-toast gap-[12px] border border-solid border-[#8c79554d] p-[10px] absolute left-[0] bottom-[82px] z-[2] flex rounded-[5px] sm:py-[12px] sm:bottom-[90px] sm:pr-[18px] sm:pl-[12px] ${styles['macro-toast']}`}
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
        className={`action-bar gap-[6px] border border-solid border-[#89764c] p-[9px] absolute bottom-[8px] left-[0] flex rounded-[5px] sm:left-[32px] ${styles['action-bar']}`}
      >
        {['frost', 'wand', 'fire', 'potion', 'book'].map((icon, i) => (
          <span
            key={icon}
            className={
              i === 1 ? `selected-action rounded-[4px] relative ${styles['selected-action']}` : ``
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
