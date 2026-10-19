// playwright-cli run-code --filename scripts/verify-release-ui.js
// Synthetic, intercepted API only. Native Telegram/keyboard acceptance remains manual.
async page => {
  await page.route('https://telegram.org/js/telegram-web-app.js',route=>route.fulfill({body:'',contentType:'application/javascript'}));
  const state = {
    users: [{ id: 'a', username: 'synthetic_admin', realName: 'Синтетический администратор с очень длинным именем', role: 'admin', active: true, registered: true, competencies: ['Длинное название компетенции'], primaryCompetency: 'Длинное название компетенции' }],
    competencies: ['Длинное название компетенции'], faculties: [], facultyCompetencies: [],
    availabilities: {}, meetings: [], tasks: [], messages: {},
    events: [{ id: 'e', name: 'Мероприятие с очень длинным русским названием для проверки мобильного интерфейса', status: 'active' }],
    settings: { availabilityWeekCount: 5, availabilityActiveDays: [0,1,2,3,4,5,6], availabilityStartHour: 17, availabilityEndHour: 23 },
  };
  await page.unroute('**/api/**');
  await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname === '/api/state' ? state : { success: true } }));
  const results = [];
  const inspect = async name => {
    for (const [width, height] of [[320,740],[375,812],[390,844],[430,932],[768,1024],[1024,768],[844,390]]) {
      await page.setViewportSize({ width, height });
      for (const dark of [false, true]) {
        await page.evaluate(dark => document.documentElement.classList.toggle('dark-theme', dark), dark);
        const outside = await page.evaluate(() => [...document.querySelectorAll('.mega-shell input:not(.sr-only),.mega-shell select,.mega-shell textarea,.mega-shell button,.mega-shell form,.mega-shell h1,.mega-shell h2')]
          .filter(el => { const r = el.getBoundingClientRect(); return r.width && r.height && getComputedStyle(el).visibility !== 'hidden' && (r.left < -1 || r.right > innerWidth + 1); })
          .map(el => `${el.tagName}:${el.getAttribute('aria-label') || el.textContent?.trim().slice(0,60)}`));
        results.push({ name, width, height, dark, outside });
        if (outside.length) throw new Error(JSON.stringify(results.at(-1)));
        if (width === 320 || width === 1024) {
          await page.evaluate(() => scrollTo(0,0));
          await page.screenshot({ path: `output/playwright/release/${name}-${width}-${dark ? 'dark' : 'light'}.png`, fullPage: true, animations: 'disabled' });
        }
      }
    }
  };
  for (const tab of ['slots','meetings','tasks','team','faculties','profile']) {
    await page.goto(`http://127.0.0.1:15173/?tab=${tab}`);
    await page.locator('.mega-shell').waitFor();
    await inspect(tab);
    if (tab === 'meetings') {
      await page.getByRole('button',{name:'Назначить событие',exact:true}).click();
      await inspect('meeting-form');
    }
    if (tab === 'tasks') {
      await page.getByRole('button',{name:'Создать задачу',exact:true}).click();
      await inspect('task-form');
    }
    if (tab === 'team') {
      await page.getByRole('button',{name:'Создать рассылку',exact:true}).click();
      await inspect('broadcast-form');
    }
    if (tab === 'profile') {
      await page.getByRole('button',{name:'Админская панель',exact:true}).click();
      for (const section of ['Мероприятия','Встречи','Команда','Слоты','Задачи','Факультеты']) {
        const target = page.getByRole('tab',{name:section,exact:true});
        await target.click(); await inspect(`admin-${section}`);
      }
    }
  }
  return { passed: true, cases: results.length, results };
}
