/**
 * 使用教程 · 领域层
 *
 * 这里是教程内容的唯一真源：章节正文、推荐路径、阅读进度判定。
 *
 * 为什么放在 domain 而不是写成 Markdown 文件？
 *   1. 同一份内容要同时供三处使用：会话卡片（renderer）、Web 面板（client/guide-data.js）、
 *      文档生成（scripts/gen-guide.mjs）。三处各写一份必然漂移，所以内容必须是数据。
 *   2. domain 不依赖宿主，因此"教程内容是否完整、路径是否可达"能被纯函数测试覆盖。
 *
 * 写法上的两条约束（来自本插件自己的规矩）：
 *   - 每条 step 都能落到一个真实工具调用上，不留"你应该多思考"这种无法执行的话；
 *   - bad 列表写的是**具体错法**，不是"注意不要做错"。
 */

export type GuideChapterId =
  | 'start'
  | 'zone'
  | 'draft'
  | 'gate'
  | 'ledger'
  | 'recall'
  | 'review'
  | 'camp'
  | 'trouble';

/** 学习路径：给不同目的的人一条不同的走法，而不是一条长链让所有人从头看到尾。 */
export type GuideTrack = 'quick' | 'full' | 'measure';

export interface GuideStep {
  /** 要做的动作。 */
  readonly text: string;
  /** 对应的工具调用示例（原样可抄）。 */
  readonly call?: string;
}

export interface GuideChapter {
  readonly id: GuideChapterId;
  readonly title: string;
  /** 读完需要几分钟。用作"先看哪章"的排序依据，不是精确计时。 */
  readonly minutes: number;
  /** 一句话：这章解决什么问题。 */
  readonly oneLine: string;
  /** 谁该读这章。 */
  readonly forWhom: string;
  readonly steps: readonly GuideStep[];
  /** 做对了长什么样。 */
  readonly good: readonly string[];
  /** 常见错法（具体的，不是抽象的）。 */
  readonly bad: readonly string[];
  /** 自检问题：答不上来就说明这章还没读懂。 */
  readonly check: readonly string[];
}

export interface GuideProgress {
  readonly track: GuideTrack;
  readonly read: readonly GuideChapterId[];
  /** ISO 时间；用于"上次读到哪"的稳定性，不参与判定。 */
  readonly updatedAt: string;
}

export interface GuideTrackMeta {
  readonly id: GuideTrack;
  readonly label: string;
  readonly oneLine: string;
  readonly chapters: readonly GuideChapterId[];
}

export const GUIDE_DOC_KEY = 'guide.progress';

export const GUIDE_TRACKS: Readonly<Record<GuideTrack, GuideTrackMeta>> = Object.freeze({
  quick: {
    id: 'quick',
    label: '先能用',
    oneLine: '只想让闸门今天生效：建档、写丑版本、被拦住一次，就算装好了。',
    chapters: ['start', 'zone', 'draft', 'gate'],
  },
  full: {
    id: 'full',
    label: '完整走一遍',
    oneLine: '五个环节全装上：先手 → 留痕 → 回收 → 复盘。适合决定认真用下去的人。',
    chapters: ['start', 'zone', 'draft', 'gate', 'ledger', 'recall', 'review'],
  },
  measure: {
    id: 'measure',
    label: '看效果',
    oneLine: '关心"到底有没有变强"：先建基线，四周后用两个比值验收。',
    chapters: ['start', 'camp', 'review'],
  },
});

export const GUIDE_CHAPTERS: readonly GuideChapter[] = Object.freeze([
  {
    id: 'start',
    title: '五分钟上手',
    minutes: 5,
    oneLine: '跑通一次完整流程：建档 → 丑版本 → 交付。先体验到"被拦一次"，再谈其他。',
    forWhom: '所有人。哪怕只想看看这插件干什么，也先读这章。',
    steps: [
      {
        text: '让模型帮你建第一个任务的档。它会先问你三个问题，**照实回答，别让它替你猜**——判错的代价是后面所有闸门一起失效。',
        call: 'xianshou_start(title="重构订单模块", repeatable=true, within_competence=true, growth_relevant=true)',
      },
      {
        text: '返回里会带一个 task_id 和分区结论。红区表示"这件事你必须先动手"，黄区表示"可以先问但要能复述"，绿区表示"放开用"。',
      },
      {
        text: '现在试着让模型直接写代码或写文档。红区任务会被闸门拦住——这就是它存在的意义：把"我先想想"变成一个必须的动作。',
      },
      {
        text: '自己写一个丑版本：三段提纲、伪代码、或者三条关键判断。**不要润色，不要补全**，它丑才是对的。',
        call: 'xianshou_draft(task_id="xs-1a2b3c", content="1. 先拆领域模型\\n2. 因为库存扣减是外部契约，所以先做防腐层\\n3. 结论：迁移顺序是最大风险", minutes_spent=15)',
      },
      {
        text: '落稿后闸门放行。正常干活，交付前记得标来源（见留痕那章），然后交付。',
        call: 'xianshou_deliver(task_id="xs-1a2b3c")',
      },
    ],
    good: [
      '第一次被拦住时，你的反应是"对，我确实该先想一下"，而不是"这插件真烦"。',
      '丑版本丑到你自己都不想给别人看——那是正常状态，它的读者只有你。',
    ],
    bad: [
      '让模型代写丑版本。这一步被代劳，整个方案就失效了：闸门变成了打卡，账本记的是 AI 的产出。',
      '为了不被拦，把任务全判成绿区。三个判据是给自己用的，糊弄它等于糊弄自己。',
    ],
    check: ['你能说清刚才那个任务为什么是红区吗？', '你的丑版本里，有哪一条是"结论"而不是"待办"？'],
  },
  {
    id: 'zone',
    title: '三区分级：什么必须先手',
    minutes: 6,
    oneLine: '用三个是非题判断一个任务该走哪条路。分级不是按任务类型，而是按它对你的意义。',
    forWhom: '所有人。分错区，后面的闸门就全是噪音。',
    steps: [
      {
        text: '**判据一：以后还要重复做吗？** 一次性杂活（订机票、改个错别字）为否；会反复出现的（写周报、做需求评审、写 SQL）为是。',
      },
      {
        text: '**判据二：落在你的能力圈内吗？** 你现在能独立做出来为是；做不出来、需要现学为否。',
      },
      {
        text: '**判据三：跟你的成长有关吗？** 做完这件事你会变强为是；纯搬运、纯排版、纯翻译为否。',
      },
      {
        text: '三条判据的组合直接决定分区（红 = 重复且相关但不在能力圈；黄 = 在能力圈且相关；绿 = 与成长无关）。不用记规则，工具会算，你只要如实回答。',
      },
      {
        text: '不确定的时候往红区靠。红区的代价是多写十分钟丑版本，绿区的代价是三个月后不知道自己会不会做。',
      },
    ],
    good: [
      '同一个任务类型，在不同阶段会落到不同区：第一次写架构文档是红区，第十次是黄区。这是进步的证据。',
      '你能一眼说出"这个我判绿区，因为它跟我的成长无关"，而不是含糊地说"这个比较简单"。',
    ],
    bad: [
      '按"难不难"分区。难但与你无关的事（比如配个环境）应该是绿区，不难但必须你自己想的事才是红区。',
      '把"我没时间"当成判据。时间压力不是分区的输入。',
    ],
    check: ['举一个你上周做成绿区、但其实该是红区的任务。', '你的红区任务里，有几个是"其实我会做，只是不想做"？'],
  },
  {
    id: 'draft',
    title: '先手稿：丑版本写到什么程度算够',
    minutes: 5,
    oneLine: '先手稿不是为了交差，是为了在问 AI 之前，把自己已有的判断固定下来。',
    forWhom: '所有会在红区被拦的人。这章决定你会不会把闸门当成形式。',
    steps: [
      {
        text: '三种合法形态，选一种：三段提纲（问题 / 判断 / 路径）、伪代码（关键函数签名 + 数据流）、或三条以上关键判断。',
      },
      {
        text: '校验是硬的：不足 80 字，且既无结构也无三条判断的内容会被拒绝。这不是字数洁癖——三条判断是"你到底想过没有"的最低证据。',
        call: 'xianshou_draft(task_id="xs-1a2b3c", content="...", key_judgements=["库存与订单解耦","先做防腐层","状态机最后迁移"])',
      },
      {
        text: '自报投入分钟数（minutes_spent）。申报后被校验：3 分钟写出 800 字结构化提纲，会被判为可疑。',
      },
      {
        text: '写完不要回去润色。带着这份丑东西去问 AI，问的是"我的判断哪里错了"，而不是"帮我做这个"。',
      },
    ],
    good: [
      '丑版本里有至少一个"结论"，而不是清一色的"要做 A、要做 B"。',
      '你问 AI 的第一句话变成了"我认为 X，理由 Y，你看哪里不成立"，而不是"帮我写个 X"。',
    ],
    bad: [
      '写成了任务清单（"1. 调研 2. 设计 3. 实现"）。这是待办，不是判断，校验可能放行但你什么也没固定下来。',
      '先问 AI，再回头补一份丑版本凑数。顺序反了，补出来的只是 AI 答案的摘要。',
    ],
    check: ['如果你的丑版本被别人拿走，他能据此指出你错在哪吗？', '里面哪一条是你自己想出来的，而不是常识？'],
  },
  {
    id: 'gate',
    title: '先手闸门：三种拦截强度怎么选',
    minutes: 4,
    oneLine: '闸门有三种模式：只记录、问一次、直接拒绝。选错模式会让它要么没用，要么让人想卸载。',
    forWhom: '所有人。装完第一周尤其要读。',
    steps: [
      {
        text: '**advisory（建议）**：只提醒不拦截，全部记录进日志。**新装插件请先跑这个模式两周。**',
      },
      {
        text: '**ask（询问）**：拦住并要求确认。默认模式，适合已经知道自己会被拦几次的人。',
      },
      {
        text: '**deny（拒绝）**：硬拦，且装了单调守卫——后续监听器无法把拒绝改成允许。适合红区纪律已经稳定的人。',
      },
      {
        text: '改模式只需要改配置 gate.mode，不用重装。先 advisory 两周，看你实际会被拦多少次；那个数字通常比预期高。',
      },
    ],
    good: [
      '你能说出自己上周被拦了几次，以及其中有几次是"拦对了"。',
      '模式是从 advisory 升到 ask 的，而不是一上来就 deny 然后三天后关掉。',
    ],
    bad: [
      '一装上就设 deny，被拦烦了之后整个插件禁用。这比不装更糟：你失去了"我试过"的记录。',
      '把 ask 模式的确认当成回车键，闭眼点通过。那么它和 advisory 没有区别，只是多了一次点击。',
    ],
    check: ['你现在是哪个模式？为什么是这个？', '上一次被拦，你是改了做法还是改了说法？'],
  },
  {
    id: 'ledger',
    title: '留痕账本：标来源为什么不能省',
    minutes: 6,
    oneLine: '按段落标 [自] / [AI] / [改]，算出 AI 占比。超过 60% 会被打回——不是为了惩罚，是为了让你看见。',
    forWhom: '会交付文档、方案、代码的人。',
    steps: [
      {
        text: '交付前，把产出按段落拆开，逐段标来源。segment_id 要稳定（"sec-2" 或"二、核心论证"），重复标记会覆盖而不是叠加。',
        call: 'xianshou_mark(task_id="xs-1a2b3c", segment_id="sec-2", tag="revised", label="二、核心论证", weight=420)',
      },
      {
        text: 'weight 用字符数，不要用 1。全用 1 的话，"写很长但全标自"就能骗过比例计算。',
      },
      {
        text: '标完跑一次审计，看比例与判定。',
        call: 'xianshou_audit(task_id="xs-1a2b3c")',
      },
      {
        text: '[AI] 占比 > 60% 时，工具会让你打回重做（rework 档）。这时候的选择只有两个：自己重写核心段落，或承认这次交付主要是 AI 的。',
      },
    ],
    good: [
      '比例落在 20%–60%：AI 用在你不擅长或不需要亲自做的部分，核心判断是你的。',
      '标 [改] 的时候，你能说出改了哪里——改了措辞不算，改了结论才算。',
    ],
    bad: [
      '全标 [自]。这是最容易做也最没用的做法：账本记的是你的自我评价，不是事实。',
      '把 [改] 当垃圾桶：AI 写完只改了两个词也标 [改]。改的是措辞就用 [AI]，改的是判断才用 [改]。',
    ],
    check: ['你最近一次交付，[AI] 占比是多少？敢不敢让它超过 60% 一次看看？', '有哪一段你标了 [自]，但其实是从 AI 那里看来的？'],
  },
  {
    id: 'recall',
    title: '回收闸门：24 小时与 7 天',
    minutes: 5,
    oneLine: '交付不是终点。24 小时后复述一次，7 天后再复述一次，答不上来说明东西不是你的。',
    forWhom: '已经跑通一次完整流程的人。',
    steps: [
      {
        text: '交付后 24 小时，回答三个问题：这段的核心结论是什么？为什么是这个结论而不是另一个？如果前提变了，哪一部分会先崩？',
        call: 'xianshou_recall(task_id="xs-1a2b3c", window="d24h", answers=["...","...","..."], self_report=[2,1,2])',
      },
      {
        text: '每题自评 0–2 分。三题合计低于 80% 会被打回黄区：任务重新打开，你需要再想一遍。',
      },
      {
        text: '同一窗口不可重答。答不上来就是答不上来，重答一次只会得到背下来的答案。',
      },
      {
        text: '7 天窗口同理。到期的任务会提醒你，提醒不依赖定时器——重启后也会补推。',
      },
    ],
    good: [
      '你答得出"如果前提变了哪部分先崩"，而不只是复述结论。',
      '被打回黄区时，你的反应是回去补，而不是把自评分改高。',
    ],
    bad: [
      '把三个问题当成形式，每题给 2 分。那么这一层就完全失效，且你自己不知道。',
      '交付完就再也不看。两周后你会在另一个任务里重新遇到同一个问题，然后重新问一遍 AI。',
    ],
    check: ['你还记得三天前交付的那份东西的核心结论吗？', '如果现在有人问"为什么不是另一个方案"，你能答出来吗？'],
  },
  {
    id: 'review',
    title: '拒绝率与健康度：别把它当 KPI',
    minutes: 5,
    oneLine: '四个指标一起看才有意义。单独追一个数，一定会把它追坏。',
    forWhom: '用了一两周、开始想知道"有没有用"的人。',
    steps: [
      {
        text: '看健康度，四个指标一起：先手率（该先手的任务里有多少真的先手了）、[AI] 占比、回收通过率、拒绝率。',
        call: 'xianshou_health()',
      },
      {
        text: '拒绝率是判断力探针：记录每次 AI 建议你是采纳、否决还是部分修改。健康区间 15%–40%。',
        call: 'xianshou_refusal(task_id="xs-1a2b3c", suggestion_id="sug-1", decision="rejected", note="它给的方案没考虑迁移成本")',
      },
      {
        text: '拒绝率接近 0 说明你在照抄；接近 100% 说明你在为反对而反对。两个极端都不是判断力。',
      },
      {
        text: '样本不足时工具会明说"样本还不够下结论"，不画计量条。这时候任何比例都不可信，包括看起来很高的那个。',
      },
    ],
    good: [
      '你能说出拒绝率的具体数字，以及其中哪几次否决是"事后证明我对了"。',
      '先手率上去了，但 [AI] 占比没掉——说明你把 AI 用在了更外围的地方，这是健康的。',
    ],
    bad: [
      '把拒绝率当成绩，为了好看而否决。这是把探针变成了指标，探针就失效了。',
      '只看 [AI] 占比，不看回收通过率。占比低但答不上来，说明你只是换了个方式抄。',
    ],
    check: ['四个指标里，你现在最差的是哪一个？', '你的拒绝里，有几次是"懒得看"而不是"不同意"？'],
  },
  {
    id: 'camp',
    title: '四周训练营：唯一可证伪的验收',
    minutes: 7,
    oneLine: 'W1 裸考建基线 → 四周训练 → W4 同难度裸考 → 两个比值判定。这是唯一能说"我确实变强了"的证据。',
    forWhom: '决定认真用四周的人。其他人可以先跳过。',
    steps: [
      {
        text: '开营。它会记录起点时间，并按天数告诉你现在该做什么。',
        call: 'xianshou_camp(action="start", label="2026 秋 · 第 1 期")',
      },
      {
        text: 'W1 内做一次裸考：挑一个**以后还会重复**的任务，不用 AI 独立做完，记下耗时和自评质量分（0–100）。',
        call: 'xianshou_probe(kind="baseline", title="写一份需求说明", minutes=100, quality=80, ai_used=false)',
      },
      {
        text: 'W2/W3 正常用插件干活：先手、留痕、回收。这时候不要刻意"练习"，就按平常方式工作。',
      },
      {
        text: '第 22 天之后，做同难度的第二次裸考。**必须同难度、同一把尺子打分**，否则两个数不可比。',
        call: 'xianshou_probe(kind="exit", title="写另一份需求说明", minutes=108, quality=78, ai_used=false)',
      },
      {
        text: '查验收：质量 ≥ 基线 90%、耗时增幅 ≤ 20%。三档结论会告诉你哪一边失衡。',
        call: 'xianshou_camp(action="status")',
      },
    ],
    good: [
      '基线是"有点难看"的真实水平，而不是你精心准备后的最好状态。基线虚高，验收就没有意义。',
      '两次裸考用同一把尺子：比如"能直接用 60 / 同事能看懂 80 / 不用返工 90"。',
    ],
    bad: [
      '基线那次偷偷用了 AI。那么第二次测的是"AI 有多强"，不是"你有多强"。工具会拒绝 ai_used=true，但挡不住你把 AI 的输出背下来手打。',
      '为了通过验收，把第二次的质量分往上抬一分。那你测的是自欺能力。',
      '第 10 天就想做脱离测试。提前测的是"学习中的你"，和第 22 天的数不可比——工具会拦住，但你要理解为什么。',
    ],
    check: ['你的基线任务，和你现在做的工作是同一类吗？', '如果验收没通过，你会改做法还是改分数？'],
  },
  {
    id: 'trouble',
    title: '排障：出问题时看哪里',
    minutes: 4,
    oneLine: '工具报错、数据没了、面板没入口——三类问题的排查入口各不相同。',
    forWhom: '遇到问题的人，按需查。',
    steps: [
      {
        text: '工具报错：看卡片上的错误码与"怎么修正"。INVALID_ARGUMENT 是参数问题（照提示改），DOMAIN_RULE 是规则不允许（原因在提示里）。',
      },
      {
        text: '数据像是丢了：先看 xianshou_status 能不能列出任务。存储是三级降级（会话状态 → 文件 → 内存），降到内存时重启会丢。',
        call: 'xianshou_export(format="json", name="backup")',
      },
      {
        text: '换机器或重装：用导出的 json 恢复，默认 dry-run 只报告不写入。',
        call: 'xianshou_import(file="backup.json", mode="merge")',
      },
      {
        text: 'Web 面板没有入口：先 npm run doctor 判断是包的问题还是宿主/安装的问题，再按 docs/UI-INTEGRATION.md §11 的六步走。别急着重装。',
      },
      {
        text: '告警"未能从宿主读到版本号"：宿主版本探测被 Proxy 限制，已回落到基线版本，功能不受影响。要显示真实版本可设环境变量 DSH_VERSION。',
      },
    ],
    good: [
      '遇到问题先看卡片上的 error.code，而不是直接重装。',
      '怀疑数据要丢之前，先 export 一份 json 出来——导出是只读操作，不会改坏现有数据。',
    ],
    bad: [
      '一出问题就 rm -rf 数据目录。先导出，再动手。',
      '看到"降级到内存"继续干活，重启后发现全没了。降级时工具会告警，别忽略。',
    ],
    check: ['你知道自己的数据现在存在哪一级吗？', '上次报错的 error.code 是什么？'],
  },
]);

const CHAPTER_BY_ID = new Map<GuideChapterId, GuideChapter>(GUIDE_CHAPTERS.map((c) => [c.id, c]));

export function findChapter(id: string): GuideChapter | undefined {
  return CHAPTER_BY_ID.get(id as GuideChapterId);
}

export function isChapterId(value: unknown): value is GuideChapterId {
  return typeof value === 'string' && CHAPTER_BY_ID.has(value as GuideChapterId);
}

export function isTrack(value: unknown): value is GuideTrack {
  return value === 'quick' || value === 'full' || value === 'measure';
}

/** 某条路径的章节（按推荐顺序）。 */
export function trackChapters(track: GuideTrack): readonly GuideChapter[] {
  const ids = GUIDE_TRACKS[track].chapters;
  return ids.map((id) => CHAPTER_BY_ID.get(id) as GuideChapter);
}

export function emptyProgress(now: Date, track: GuideTrack = 'quick'): GuideProgress {
  return { track, read: [], updatedAt: now.toISOString() };
}

/** 存储回来的数据当不可信输入：形状不对就当作没读过，绝不半信半疑地用它。 */
export function isGuideProgress(raw: unknown): raw is GuideProgress {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const record = raw as Record<string, unknown>;
  if (!isTrack(record['track'])) return false;
  if (typeof record['updatedAt'] !== 'string') return false;
  const read = record['read'];
  if (!Array.isArray(read)) return false;
  return read.every((id) => isChapterId(id));
}

/** 标记已读。幂等：重复标记同一章不改变结果（也不刷新时间戳，避免无意义的写盘）。 */
export function markRead(progress: GuideProgress, id: GuideChapterId, now: Date): GuideProgress {
  if (progress.read.includes(id)) return progress;
  // 保持路径顺序，而不是追加顺序：目录渲染时不该随阅读顺序跳动。
  const order = GUIDE_TRACKS[progress.track].chapters;
  const next = new Set([...progress.read, id]);
  const read = [...order.filter((cid) => next.has(cid)), ...[...next].filter((cid) => !order.includes(cid))];
  return { ...progress, read, updatedAt: now.toISOString() };
}

export function setTrack(progress: GuideProgress, track: GuideTrack, now: Date): GuideProgress {
  if (progress.track === track) return progress;
  // 换路径不清空已读：用户可能先看 quick，再决定走 full，之前读过的仍然算读过。
  return { ...progress, track, updatedAt: now.toISOString() };
}

/** 当前路径里第一个未读的章节；全部读完返回 null。 */
export function nextChapter(progress: GuideProgress): GuideChapter | null {
  for (const chapter of trackChapters(progress.track)) {
    if (!progress.read.includes(chapter.id)) return chapter;
  }
  return null;
}

export interface GuideSummary {
  readonly track: GuideTrack;
  readonly trackLabel: string;
  readonly total: number;
  readonly readCount: number;
  readonly percent: number;
  readonly nextChapterId: GuideChapterId | null;
  readonly remainingMinutes: number;
  readonly done: boolean;
}

export function summarize(progress: GuideProgress): GuideSummary {
  const chapters = trackChapters(progress.track);
  const readInTrack = chapters.filter((c) => progress.read.includes(c.id));
  const next = nextChapter(progress);
  const remainingMinutes = chapters
    .filter((c) => !progress.read.includes(c.id))
    .reduce((sum, c) => sum + c.minutes, 0);
  return {
    track: progress.track,
    trackLabel: GUIDE_TRACKS[progress.track].label,
    total: chapters.length,
    readCount: readInTrack.length,
    percent: chapters.length === 0 ? 0 : readInTrack.length / chapters.length,
    nextChapterId: next ? next.id : null,
    remainingMinutes,
    done: next === null,
  };
}

/** 读一章要几分钟的合计：用于"还剩多久"这类诚实的估计。 */
export function readingTime(chapters: readonly GuideChapter[]): number {
  return chapters.reduce((sum, c) => sum + c.minutes, 0);
}
