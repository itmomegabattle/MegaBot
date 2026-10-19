// Synthetic APIs only; also runnable with Playwright CLI's WebKit browser.
async page => {
  const ensure = (value, message) => { if (!value) throw new Error(message); };
  const users = Array.from({length:6}, (_, i) => ({id:`u${i}`,username:`synthetic_${i}`,realName:`Участник ${i}`,role:i ? 'organizer' : 'admin',registered:true,active:true}));
  const state = {users,competencies:[],faculties:[],facultyCompetencies:[],availabilities:{},tasks:[],messages:{},events:[{id:'quiz',name:'Квиз',status:'active'}],
    meetings:Array.from({length:6}, (_, i) => ({id:`m${i}`,title:`Встреча ${i}`,date:'01.12.2030',time:'19:00',duration:1,type:'general',kind:i===2?'setup':'meeting',eventId:i===2?'quiz':undefined,hostId:'u0',participants:'all',status:'scheduled',attendeeIds:[],rsvpByUser:i===0?{u0:'yes'}:i===1?{u0:'no'}:{}})),
    settings:{availabilityWeekCount:2,availabilityActiveDays:[0,1,2,3,4],availabilityStartHour:17,availabilityEndHour:23,notificationDeliverySummary:{pending:0,attention:0}}};
  const diagnostics = {status:'healthy',warnings:[],persistence:{durableRevision:1,replicatedRevision:1,pendingReplication:false},queues:{notificationDelivery:{pending:0,attention:0},telegramInbox:{pending:0,failed:0},calendar:{pending:0},availabilitySheets:{pending:0}},service:{revision:'synthetic',uptimeSeconds:10,timeZone:'Europe/Moscow'}};
  await page.unroute('**/api/**');
  await page.route('https://telegram.org/js/telegram-web-app.js', route => route.fulfill({body:'',contentType:'application/javascript'}));
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({json:path==='/api/state' ? state : path==='/api/admin/diagnostics' ? diagnostics : path==='/api/notification-deliveries' ? {deliveries:[]} : {success:true}});
  });
  const checks = [];
  for (const width of [320,375,390,430,768,1024]) {
    await page.setViewportSize({width,height:900});
    await page.goto('http://127.0.0.1:15173/');
    await page.locator('.mega-shell').waitFor();
    ensure((await page.locator('nav button').allTextContents()).join('|') === 'Слоты|Задачи|Встречи|МФ|Команда', 'navigation order');
    ensure(await page.getByRole('heading',{name:'Ближайшие и текущие встречи',exact:true}).isVisible(), 'meetings must be the default');
    const list = page.locator('.order-first');
    ensure(!((await list.locator('time').allTextContents()).join('').includes('МСК')),'timezone suffix remains on meeting cards');
    const setupBadges=list.locator('.mega-meeting-badges').nth(2);
    ensure((await setupBadges.locator('span').allTextContents()).join('|')==='Монтаж|Квиз|Вся команда','setup badge order');
    const setupBoxes=await Promise.all((await setupBadges.locator('span').all()).map(badge=>badge.boundingBox()));
    ensure(setupBoxes.every(box=>Math.abs(box.y-setupBoxes[0].y)<2),'setup badges must share a row');
    ensure(setupBoxes[1].x>=setupBoxes[0].x+setupBoxes[0].width && setupBoxes[1].x+setupBoxes[1].width<=setupBoxes[2].x,'event must stay between kind and audience');
    ensure(!((await list.innerText()).includes('Ваш ответ:')),'redundant RSVP text remains');
    ensure(await list.getByRole('button',{name:'Приду',exact:true}).first().getAttribute('aria-pressed')==='true','yes selection semantics lost');
    ensure(await list.getByRole('button',{name:'Не приду',exact:true}).nth(1).getAttribute('aria-pressed')==='true','no selection semantics lost');
    ensure(await list.getByRole('button',{name:'Сбросить ответ',exact:true}).count()===0,'RSVP reset must not appear for any response');
    ensure(await list.getByRole('button',{name:'Приду',exact:true}).count()===3 && await list.getByRole('button',{name:'Не приду',exact:true}).count()===3,'yes/no RSVP controls must remain');
    const expand = list.getByRole('button',{name:'Развернуть 3',exact:true});
    const last = list.getByRole('heading',{name:'Встреча 2',exact:true}).locator('..').locator('..').locator('..');
    ensure((await expand.boundingBox()).y >= (await last.boundingBox()).y + (await last.boundingBox()).height - 1, 'meeting disclosure above cards');
    const badges = list.getByRole('heading',{name:'Встреча 0',exact:true}).locator('..').locator('..').locator('div').last();
    ensure((await badges.locator('span').allTextContents()).join('|')==='Собрание|Вся команда','meeting kind left, audience right');
    const badgeBounds=await badges.locator('span').all();
    const row=await badges.boundingBox(),kindBox=await badgeBounds[0].boundingBox(),audienceBox=await badgeBounds[1].boundingBox();
    ensure(Math.abs(kindBox.x-row.x)<2 && Math.abs(audienceBox.x+audienceBox.width-row.x-row.width)<2,'badges must align with opposite card edges');
    await page.evaluate(()=>document.fonts.ready);
    await expand.evaluate(button=>button.scrollIntoView({block:'center',behavior:'instant'}));
    const beforeExpand = await page.evaluate(()=>scrollY);
    await expand.click();
    await page.waitForTimeout(100);
    const afterExpand=await page.evaluate(()=>scrollY);
    ensure(Math.abs(afterExpand-beforeExpand)<2,`expansion changed scroll position at ${width}: ${beforeExpand} → ${afterExpand}`);
    ensure(await list.getByRole('heading',{name:'Встреча 5',exact:true}).isVisible(), 'meeting expansion');
    await list.getByRole('button',{name:'Свернуть',exact:true}).click();
    await expand.focus();
    const beforeKeyboardExpand = await page.evaluate(()=>scrollY);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
    ensure(Math.abs(await page.evaluate(()=>scrollY)-beforeKeyboardExpand)<2,'keyboard expansion changed scroll position');
    await list.getByRole('button',{name:'Свернуть',exact:true}).click();
    await page.getByRole('button',{name:'Назначить событие',exact:true}).click();
    const form = page.locator('form').filter({has:page.locator('input[type=date]')});
    for (const dark of [false,true]) {
      await page.evaluate(dark => document.documentElement.classList.toggle('dark-theme',dark), dark);
      const fields = await form.evaluate(form => [...form.querySelectorAll('input[type=date],input[type=time]')].map(input => {
        const rect=input.getBoundingClientRect(), parent=input.parentElement.getBoundingClientRect();
        return {fits:rect.right<=parent.right+1 && rect.left>=parent.left-1,appearance:getComputedStyle(input).appearance};
      }));
      ensure(fields.length===2 && fields.every(f=>f.fits && f.appearance==='none'), `native fields overflow at ${width}`);
      if (dark) ensure(!(await page.locator('.brand-background').evaluate(el=>getComputedStyle(el).backgroundImage)).includes('255, 255, 255'), 'white background under dark canvas');
      checks.push({width,dark,nativeFields:true});
    }
    await page.locator('nav').getByRole('button',{name:'Команда',exact:true}).click();
    ensure(await page.getByText('Telegram подключён',{exact:true}).count()===0,'positive Telegram status remains on team cards');
    const service=page.getByRole('button',{name:'Состояние сервиса',exact:true});
    const delivery=page.getByRole('button',{name:'Доставка сообщений',exact:true});
    ensure(Math.abs((await service.boundingBox()).y-(await delivery.boundingBox()).y)<1, 'admin controls must be on one row');
    await service.click(); await page.locator('#service-diagnostics').waitFor();
    ensure(await delivery.evaluate(button => !!(button.compareDocumentPosition(document.querySelector('#service-diagnostics')) & Node.DOCUMENT_POSITION_FOLLOWING)), 'keyboard order must follow the visible control row');
    ensure((await page.locator('#service-diagnostics').boundingBox()).y >= (await delivery.boundingBox()).y+(await delivery.boundingBox()).height, 'diagnostics must open below both controls');
    await delivery.click(); await page.locator('#delivery-journal').waitFor();
    ensure(await page.locator('#service-diagnostics').count()===0, 'only the selected admin panel stays open');
    const teamExpand=page.getByRole('button',{name:'Развернуть 3',exact:true});
    ensure((await teamExpand.boundingBox()).y > (await page.getByText('Участник 2',{exact:true}).boundingBox()).y, 'team disclosure above users');
    await teamExpand.click(); ensure(await page.getByText('Участник 5',{exact:true}).isVisible(), 'team expansion');
    ensure(!/[✓✔✅]/.test(await page.locator('.mega-shell').innerText()), 'checkmark glyph remains');
    if(width===375 || width===1024) await page.screenshot({path:`output/playwright/hotfix-team-${width}.png`,fullPage:true,animations:'disabled'});
    await page.goto('http://127.0.0.1:15173/?tab=profile');
    await page.getByRole('button',{name:'Админская панель',exact:true}).click();
    for (const dark of [false,true]) {
      await page.evaluate(dark=>document.documentElement.classList.toggle('dark-theme',dark),dark);
      const colors = await page.locator('.mega-admin-tabs').evaluate(tabs=>{
        const luminance = color => {
          const rgb=color.match(/[\d.]+/g).slice(0,3).map(Number).map(n=>n/255).map(n=>n<=0.04045?n/12.92:((n+0.055)/1.055)**2.4);
          return rgb[0]*0.2126+rgb[1]*0.7152+rgb[2]*0.0722;
        };
        return [...tabs.querySelectorAll('button')].map(button=>{
          const style=getComputedStyle(button),a=luminance(style.color),b=luminance(style.backgroundColor);
          return {selected:button.getAttribute('aria-selected'),contrast:(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05),background:style.backgroundColor,parent:getComputedStyle(tabs).backgroundColor};
        });
      });
      ensure(colors.every(c=>c.contrast>=4.5&&c.background!==c.parent),`admin tab contrast/elevation: ${JSON.stringify({width,dark,colors})}`);
      ensure(colors.find(c=>c.selected==='true').background!==colors.find(c=>c.selected==='false').background,'admin active state indistinguishable');
      await page.getByRole('tab',{name:'Встречи',exact:true}).click();
      if(width===375 || width===1024) {await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:`output/playwright/refined-admin-${width}-${dark?'dark':'light'}.png`,fullPage:true,animations:'disabled'});}
    }
  }
  users[0].role='organizer';
  await page.goto('http://127.0.0.1:15173/?tab=team'); await page.locator('.mega-shell').waitFor();
  ensure(await page.getByRole('button',{name:'Состояние сервиса',exact:true}).count()===0 && await page.getByRole('button',{name:'Доставка сообщений',exact:true}).count()===0, 'admin controls leaked to organizer');
  await page.goto('http://127.0.0.1:15173/?tab=slots'); await page.locator('.mega-shell').waitFor();
  ensure(!((await page.locator('.mega-shell').innerText()).includes('«Я в ауте» означает')),'unrequested weekly-out explanation remains');
  await page.getByRole('button',{name:'Выбрать: 17:00–18:00',exact:true}).first().click();
  ensure(!/[✓✔✅]/.test(await page.locator('.mega-shell').innerText()), 'slot checkmark remains');
  ensure(await page.getByRole('button',{name:'Выбрано: 17:00–18:00',exact:true}).first().getAttribute('aria-pressed')==='true', 'selection semantics lost');
  ensure(!((await page.locator('.mega-shell').innerText()).includes('Выбрано:')),'visible selected-slot summary remains');
  return {passed:true,checks:checks.length,checksDetails:checks,adminIsolation:true};
}
