export function birthdayGiftCollectionText(environment: NodeJS.ProcessEnv = process.env) {
  const phone = environment.BIRTHDAY_PAYMENT_PHONE || '89105408050';
  const bank = environment.BIRTHDAY_PAYMENT_BANK || 'Т-Банк';
  const requestedAmount = Number(environment.BIRTHDAY_GIFT_MAX_AMOUNT);
  const maxAmount = Number.isFinite(requestedAmount) && requestedAmount > 0 ? requestedAmount : 400;
  return `🎁 Сбор на подарок: переводите на ${bank} по номеру ${phone}.`
    + `\nДо ${maxAmount} ₽ с человека — это максимальная сумма, можно отправить меньше.`;
}
