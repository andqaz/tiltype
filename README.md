# TilType AI 1.8.1

## Русский

TilType AI помогает набирать текст в ONLYOFFICE на русском, казахском и английском. Первое продолжение появляется у курсора, остальные варианты доступны в списке. Стрелками можно выбрать подсказку, клавишей **Tab** — принять её.

- **По одному слову или целиком.** Каждый Tab вставляет очередное слово выбранной фразы. В любой момент можно продолжить печатать самостоятельно. Для вставки всей фразы за одно нажатие выберите «Вся подсказка» в настройках.
- **Быстрый повторный Tab.** Плагин запоминает следующее нажатие, пока редактор завершает предыдущую вставку.
- **Адаптивные настройки.** Окно подстраивается под высоту видимых элементов и локализованных подписей.

**Модель.** Один локальный Transformer с 15,2 млн параметров обрабатывает все три языка. Он строит продолжение из частей слов с учётом текста перед курсором. Веса FP16 занимают около 30,5 МБ. Модель работает на CPU через WebAssembly SIMD в отдельном потоке. Текст документа обрабатывается на компьютере пользователя.

**Пример.** После «Спасибо за» модель предлагает «помощь». Одно нажатие Tab завершает фразу.

![Подсказка на русском в ONLYOFFICE](https://github.com/andqaz/tiltype/releases/download/v1.8.1/completion-ru.gif)

[Настройки на русском](https://github.com/andqaz/tiltype/releases/download/v1.8.1/settings-ru.png) · [Скачать плагин](https://github.com/andqaz/tiltype/releases/download/v1.8.1/tiltype.plugin). Откройте менеджер плагинов ONLYOFFICE Desktop Editors, выберите установку из файла и укажите скачанный файл. После обновления заново откройте документ.

## Қазақша

TilType AI ONLYOFFICE редакторында қазақша, орысша және ағылшынша мәтін теруге көмектеседі. Бірінші ұсыныс меңзердің жанында, ал қалған нұсқалар тізімде көрінеді. Қажетті нұсқаны көрсеткі пернелермен таңдап, **Tab** пернесімен енгізуге болады.

- **Сөзбе-сөз немесе тұтас енгізу.** Tab пернесін әр басқанда таңдалған тіркестің келесі сөзі енгізіледі. Қалаған сәтте мәтінді өзіңіз жалғастыра аласыз. Тіркесті бірден енгізу үшін баптаулардан «Ұсынысты толық енгізу» режимін таңдаңыз.
- **Tab пернесін қатарынан басу.** Редактор алдыңғы сөзді енгізіп жатқанда пернені қайта бассаңыз, плагин келесі сөзді де енгізеді.
- **Баптаулар терезесі.** Терезенің биіктігі көрініп тұрған элементтер мен таңдалған тілдегі жазуларға қарай өзгереді.

**Модель.** Үш тілге ортақ, 15,2 млн параметрі бар Transformer моделі меңзер алдындағы мәтінге сүйеніп, сөз бөліктерінен жалғасын құрастырады. FP16 форматындағы салмақтардың көлемі шамамен 30,5 МБ. Модель компьютердің орталық процессорында WebAssembly SIMD арқылы бөлек ағында жұмыс істейді. Құжат мәтіні пайдаланушының компьютерінде өңделеді.

**Мысал.** «Қазақстан Республикасының» деп тергенде тізімдегі үшінші нұсқа — «Премьер-Министрі». Оны көрсеткі пернемен таңдап, Tab арқылы енгізуге болады.

![ONLYOFFICE редакторында қазақша ұсынысты таңдау](https://github.com/andqaz/tiltype/releases/download/v1.8.1/completion-kk.gif)

[Қазақша баптаулар](https://github.com/andqaz/tiltype/releases/download/v1.8.1/settings-kk.png) · [Плагинді жүктеп алу](https://github.com/andqaz/tiltype/releases/download/v1.8.1/tiltype.plugin). ONLYOFFICE Desktop Editors ішінде плагиндер менеджерін ашып, файлдан орнатуды таңдаңыз да, жүктелген файлды көрсетіңіз. Жаңартқаннан кейін құжатты қайта ашыңыз.

## English

TilType AI helps you write in English, Kazakh and Russian in ONLYOFFICE. The first suggestion appears at the cursor. Use the arrow keys to choose an alternative from the list and press **Tab** to accept it.

- **One word at a time or the entire suggestion.** Each Tab accepts the next word of the selected phrase. Keep typing whenever you want to finish it yourself. To accept a whole phrase in one keystroke, select “Entire suggestion” in settings.
- **Quick successive Tabs.** A second Tab is queued while the editor finishes inserting the first word.
- **Adaptive settings window.** The dialog adjusts its height to fit the visible controls and their translated labels.

**Model.** A single local Transformer with 15.2 million parameters serves all three languages. It uses the text before the cursor to generate continuations from subword tokens. The FP16 weights occupy about 30.5 MB. Inference runs on the CPU in a separate worker using WebAssembly SIMD. Document text is processed on the user's computer.

**Example.** After “Thank you”, the model suggests “for your help”. Two Tabs accept “for your”. The writer then types “time.” to finish “Thank you for your time.”

![Accepting two words and typing a different ending in ONLYOFFICE](https://github.com/andqaz/tiltype/releases/download/v1.8.1/word-by-word.gif)

[Settings in English](https://github.com/andqaz/tiltype/releases/download/v1.8.1/settings.png) · [Download the plugin](https://github.com/andqaz/tiltype/releases/download/v1.8.1/tiltype.plugin). Open the plugin manager in ONLYOFFICE Desktop Editors, choose installation from a file and select the downloaded package. Reopen your document after updating.

## Build

Run `python tools/package_desktop.py` to package the [desktop plugin](desktop) as `dist/tiltype.plugin`. The WebAssembly decoder source is in [tools/decoder.c](tools/decoder.c). Run `npm test` for the repository tests. See [third-party notices](desktop/licenses).
