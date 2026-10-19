// Run with playwright-cli run-code --filename scripts/verify-setup-duration-ui.js.
// Local Vite preview only; all API traffic is intercepted, no real bot or database.
async page => {
  const ensure=(value,message)=>{if(!value)throw new Error(message);};
  const state={
    users:[{id:'a',username:'synthetic_admin',realName:'Синтетический администратор',role:'admin',active:true,registered:true,avatarSeed:'a'}],
    competencies:[],availabilities:{},meetings:[],tasks:[],messages:{},
    events:[{id:'e',name:'Синтетическое мероприятие с длинным названием для проверки мобильной формы',status:'active'}],
    settings:{availabilityWeekCount:4,availabilityActiveDays:[0],availabilityStartHour:18,availabilityEndHour:21},
  };
  const calls=[];
  await page.route('https://telegram.org/js/telegram-web-app.js', route=>route.fulfill({body:'',contentType:'application/javascript'}));
  await page.unroute('**/api/**');
  await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/api/state')return route.fulfill({json:state});
    if(url.pathname==='/api/meeting') {
      const body=route.request().postDataJSON();calls.push(body);
      state.meetings.push({...body,id:'m',status:'scheduled',attendeeIds:[]});
      return route.fulfill({json:{success:true,meeting:state.meetings[0]}});
    }
    if(url.pathname==='/api/meeting/update') {
      const body=route.request().postDataJSON();calls.push(body);
      Object.assign(state.meetings[0],body);
      return route.fulfill({json:{success:true,meeting:state.meetings[0]}});
    }
    return route.fulfill({json:{success:true}});
  });
  await page.goto('http://127.0.0.1:15173/?tab=meetings');
  await page.evaluate(()=>sessionStorage.clear());await page.reload();
  await page.getByRole('button',{name:'Назначить событие',exact:true}).click();
  for(const name of [/Собрание/, /Вайбик/, /Монтаж/]) {
    await page.locator('label').filter({has:page.getByRole('radio',{name})}).click();
    ensure(await page.locator('input[type=time]').getAttribute('min')===null && await page.locator('input[type=time]').getAttribute('max')===null,'event time still restricted to slot hours');
  }
  await page.locator('label').filter({has:page.getByRole('radio',{name:/Монтаж/})}).click();
  await page.getByRole('combobox',{name:'Мероприятие',exact:true}).selectOption('e');
  ensure((await page.getByRole('combobox',{name:'Длительность',exact:true}).locator('option').evaluateAll(options=>options.map(option=>option.value))).join(',')==='1,2,3,4,5,6,7,8,9,10,11,12','setup must offer exactly 12 whole hours');
  await page.getByRole('combobox',{name:'Длительность',exact:true}).selectOption('12');
  await page.locator('label').filter({has:page.getByRole('radio',{name:/Вайбик/})}).click();
  await page.locator('label').filter({has:page.getByRole('radio',{name:/Монтаж/})}).click();
  ensure(await page.getByRole('combobox',{name:'Длительность',exact:true}).inputValue()==='12','changing kind erased duration');
  await page.getByRole('combobox',{name:'Мероприятие',exact:true}).selectOption('e');
  await page.locator('input[type=date]').fill('2030-01-05');
  await page.locator('input[type=time]').fill('00:00');
  ensure(await page.locator('input[type=time]').getAttribute('min')===null && await page.locator('input[type=time]').getAttribute('max')===null,'setup still restricted to slot hours');
  const measurements=[];
  for(const width of [320,375,390,430,768,1024]) {
    await page.setViewportSize({width,height:900});
    for(const dark of [false,true]) {
      await page.evaluate(dark=>document.documentElement.classList.toggle('dark-theme',dark),dark);
      const result=await page.locator('form').filter({has:page.getByRole('combobox',{name:'Длительность',exact:true})}).evaluate(form=>{
        const elements=[form,...form.querySelectorAll('input,select,textarea,button')];
        const outside=elements.filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&(r.left<-1||r.right>innerWidth+1);}).map(el=>el.tagName);
        return {outside,width:innerWidth,scrollWidth:document.documentElement.scrollWidth};
      });
      ensure(result.outside.length===0,`form overflow at ${width}: ${result.outside}`);
      ensure(result.scrollWidth<=width+1,`page overflow at ${width}`);
      measurements.push({...result,dark});
      if(width===320||width===1024)await page.screenshot({path:`output/playwright/setup-duration/${width}-${dark?'dark':'light'}.png`,fullPage:true,animations:'disabled'});
    }
  }
  await page.setViewportSize({width:390,height:900});
  await page.getByRole('button',{name:'Запланировать монтаж',exact:true}).click();
  await page.getByRole('button',{name:'Назначить событие',exact:true}).waitFor();
  ensure(calls.length===1&&calls[0].kind==='setup'&&calls[0].duration===12,'UI did not submit selected setup duration');
  ensure(calls[0].participants==='all'&&calls[0].eventId==='e','setup audience/event changed');
  ensure(calls[0].date==='05.01.30'&&calls[0].time==='00:00','weekend midnight changed');
  await page.goto('http://127.0.0.1:15173/?tab=profile');
  await page.getByRole('button',{name:'Админская панель',exact:true}).click();
  await page.getByRole('tab',{name:'Встречи',exact:true}).click();
  await page.getByRole('button',{name:'Редактировать встречу Монтаж',exact:true}).click();
  for(const name of [/Собрание/, /Вайбик/, /Монтаж/]) {
    await page.locator('label').filter({has:page.getByRole('radio',{name})}).click();
    ensure(await page.locator('input[type=time]').getAttribute('min')===null && await page.locator('input[type=time]').getAttribute('max')===null,'admin event time still restricted to slot hours');
  }
  await page.getByRole('combobox',{name:'Мероприятие',exact:true}).selectOption('e');
  await page.locator('input[type=date]').fill('2030-01-06');
  await page.locator('input[type=time]').fill('23:59');
  ensure(await page.getByRole('combobox',{name:'Длительность',exact:true}).inputValue()==='12','admin edit lost stored duration');
  await page.getByRole('combobox',{name:'Длительность',exact:true}).selectOption('1');
  for(const width of [320,375,390,430,768,1024]) {
    await page.setViewportSize({width,height:900});
    for(const dark of [false,true]) {
      await page.evaluate(dark=>document.documentElement.classList.toggle('dark-theme',dark),dark);
      const outside=await page.locator('form').filter({has:page.getByRole('combobox',{name:'Длительность',exact:true})}).evaluate(form=>
        [form,...form.querySelectorAll('input,select,textarea,button')].filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&(r.left<-1||r.right>innerWidth+1);}).map(el=>el.tagName));
      ensure(outside.length===0,`admin form overflow at ${width}: ${outside}`);
      measurements.push({width,dark,admin:true,outside});
      if(width===320)await page.screenshot({path:`output/playwright/setup-duration/admin-${width}-${dark?'dark':'light'}.png`,fullPage:true,animations:'disabled'});
    }
  }
  await page.getByRole('button',{name:'Сохранить монтаж',exact:true}).click();
  await page.getByRole('heading',{name:'Управление встречами',exact:true}).waitFor();
  ensure(calls.length===2&&calls[1].duration===1,'admin form did not save selected duration');
  ensure(calls[1].date==='06.01.30'&&calls[1].time==='23:59','admin weekend late time changed');
  return { passed: true, checks: measurements.length, submittedDuration: calls[0].duration, updatedDuration: calls[1].duration, measurements };
}
