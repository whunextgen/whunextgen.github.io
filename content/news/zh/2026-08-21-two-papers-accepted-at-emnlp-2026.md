---
title: 科研进展｜实验室两项成果亮相 EMNLP 2026，开展海报与口头报告交流
date: '2026-10-29'
category: Paper
isPinned: false
isPublished: true
order: 0
author: CLAIN
summary: 张恩泽为第一作者的 DITING 和黄希扬为第一作者的 SiMing-Bench 被 EMNLP 2026 主会录用，分别通过海报和口头报告交流，关注网络文学翻译文化语义评测与临床技能视频流程判断。
coverImage: /news/2026/emnlp-diting-poster.png
---

武汉大学认知语言与信息实验室（CLAIN）两篇研究论文 **DITING** 和 **SiMing-Bench** 被 **EMNLP 2026 主会**录用。两项工作分别围绕网络文学翻译中的文化语义评测，以及临床技能视频中的操作流程正确性判断展开研究，第一作者分别为**张恩泽**和**黄希扬**。

EMNLP 2026 于 **2026 年 10 月 24 日至 29 日**在匈牙利布达佩斯举行。本次会议中，DITING 通过 **Poster 海报展示**开展交流，黄希扬就 SiMing-Bench 作 **Oral 口头报告**，介绍研究问题、评测设计和实验发现。

两项研究面对的任务不同，但都关注一个具体问题：当模型已经能够生成流畅文本、识别视频动作时，现有评价是否足以说明它理解了任务中真正重要的信息？围绕这一问题，研究团队分别从文化语义和专业操作流程出发，构建更有针对性的评测工具。

## DITING：让网络文学翻译评测深入文化语义

**论文题目：** [DITING: Evaluating Sentence-Level Cultural Meaning in Web Novel Translation](https://aclanthology.org/2026.emnlp-main.1959/)

网络文学翻译需要保留人物语气、文化表达以及上下文中的隐含信息。例如，中文表达“吃狗粮”在特定语境下指向旁观他人亲密互动的体验，若只处理字面词义，就可能丢失情境和人物情绪。单一的整体翻译分数难以说明模型能否稳定处理这些细节。

针对这一问题，研究团队提出 **DITING 评测框架**，从**习语翻译、词义歧义、术语本地化、时态一致性、零代词消解和文化安全**六个维度考察译文，细化对句子层面文化与语用信息的分析。

研究构建包含 **18,000 余条专家标注中英句对**的评测基准，并提出基于多智能体推理的评测器 **AgentEval**。配套的 **MetricAlign** 元评测基准包含 **1,440 组样本对**，用于检验自动评测结果与专家判断的一致程度。通过数据、评价维度和评测器之间的配合，DITING 为定位具体能力短板提供了更细致的依据。

对 **14 个翻译系统**的评测显示，前沿大语言模型虽然整体表现较好，但不同维度上的进步并不均衡，零代词消解仍是突出难点。这意味着，评价翻译模型时，需要进一步考察其对隐含指代、语境和文化表达的处理能力，避免整体排名掩盖具体问题。

### DITING 海报展示

在会议海报交流环节，DITING 以具体翻译案例、六维评价框架、数据构建过程和主要实验发现呈现研究思路。海报将评测维度与示例相结合，帮助参会者理解文化语义问题如何进入数据标注和模型评价。

<figure>
  <img src="/news/2026/emnlp-diting-poster.png" alt="DITING 在 EMNLP 2026 的海报展示现场" loading="lazy" />
  <figcaption>DITING 在 EMNLP 2026 的海报展示现场</figcaption>
</figure>

**论文作者（按原文顺序）：** Enze Zhang、Jiaying Wang、Mengxi Xiao、Jifei Liu、Zhiwei Hu、Ziyan Kuang、Rui Dong、Youzhong Dong、Mohsinul Kabir、Victor Gutierrez-Basulto、Min Peng、Qianqian Xie、Sophia Ananiadou。

- [正式论文](https://aclanthology.org/2026.emnlp-main.1959/)
- [代码与数据](https://github.com/whunextgen/DITING)

## SiMing-Bench：判断临床技能操作流程是否正确

**论文题目：** [SiMing-Bench: Evaluating Procedural Correctness from Continuous Interactions in Clinical Skill Videos](https://aclanthology.org/2026.emnlp-main.2203/)

临床技能考核要求对完整操作流程作出判断。视频中是否出现某个动作、动作先后顺序如何，只是其中一部分；评估者还需要理解每一步交互如何改变当前状态，以及这些变化怎样影响后续操作的正确性。

研究团队提出 **SiMing-Bench**，以真实临床技能考核视频为基础，覆盖**心肺复苏、自动体外除颤器操作和球囊面罩通气**等任务。配套数据集 **SiMing-Score** 将完整视频与标准化分步评分规则、双专家标注相结合，评估模型能否依据临床规范理解连续操作。

研究分别从整体评分、步骤层面的判断，以及正确与错误步骤的识别等角度考察模型表现。这样的设置能够进一步分析：模型对整套流程的评价是否与医生一致，以及看似合理的整体分数是否掩盖了关键步骤上的错误。

实验发现，多种开源与闭源多模态大语言模型的判断与医生评价仍存在明显差距。即使整体评分相关性看似可以接受，模型对中间步骤的判断也可能较弱。研究由此指出，对连续交互和流程状态变化的建模，是专业视频评估需要进一步解决的问题。

### 黄希扬作口头报告

黄希扬在 EMNLP 2026 作口头报告，介绍 SiMing-Bench 的研究动机、临床技能视频评测设置及实验结果。报告从整体评价与步骤判断两个层次展开，讨论多模态模型的判断能否与专业评价相一致，以及如何识别粗粒度评价难以揭示的能力不足。

<figure>
  <img src="/news/2026/emnlp-xiyang-huang-oral.png" alt="黄希扬在 EMNLP 2026 作 SiMing-Bench 口头报告" loading="lazy" />
  <figcaption>黄希扬在 EMNLP 2026 作 SiMing-Bench 口头报告</figcaption>
</figure>

**论文作者（按原文顺序）：** Xiyang Huang、Jiawei Lin、Keying Wu、Jiaxin Huang、Kailai Yang、Renxiong Wei、Cheng Zeng、Jiayi Xiang、Ziyan Kuang、Min Peng、Qianqian Xie、Sophia Ananiadou。

- [正式论文](https://aclanthology.org/2026.emnlp-main.2203/)
- [论文预印本](https://arxiv.org/abs/2604.09037)

## 会议链接

- [EMNLP 2026 官网](https://2026.emnlp.org/)
- [主会录用名单](https://2026.emnlp.org/program/main_papers/)
