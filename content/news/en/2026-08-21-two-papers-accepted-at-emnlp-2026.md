---
title: CLAIN Presents DITING and SiMing-Bench at EMNLP 2026
date: '2026-10-29'
category: Paper
isPinned: false
isPublished: true
order: 0
author: CLAIN
summary: DITING, first-authored by Enze Zhang, and SiMing-Bench, first-authored by Xiyang Huang, were accepted to the EMNLP 2026 main conference and shared through a poster presentation and an oral talk.
coverImage: /news/2026/emnlp-diting-poster.png
---

Two CLAIN research papers, **DITING** and **SiMing-Bench**, were accepted to the **EMNLP 2026 main conference**. First-authored by **Enze Zhang** and **Xiyang Huang**, respectively, they investigate cultural meaning in web-novel translation and procedural correctness in clinical skill videos.

EMNLP 2026 took place in **Budapest, Hungary, on 24–29 October 2026**. DITING was shared through a **poster presentation**, while **Xiyang Huang gave an oral presentation** on SiMing-Bench, introducing its research questions, evaluation design and findings.

Both studies ask whether existing evaluation captures the information that matters in a task once a model can produce fluent text or recognize actions. They approach this question through two different settings: cultural and pragmatic meaning in translation, and professional judgments about clinical procedures.

## DITING: Examining Cultural Meaning in Translation

**Paper:** [DITING: Evaluating Sentence-Level Cultural Meaning in Web Novel Translation](https://aclanthology.org/2026.emnlp-main.1959/)

Web-novel translation must preserve characterization, cultural expressions and information implied by context. For example, the Chinese expression “吃狗粮” can describe witnessing other people's romantic affection. A literal rendering can lose this social meaning even if the individual words are translated correctly. Aggregate translation-quality scores provide limited evidence about these distinctions.

**DITING** examines six dimensions: **idiom translation, lexical ambiguity, terminology localization, tense consistency, zero-pronoun resolution and cultural safety**. These dimensions make sentence-level cultural and pragmatic phenomena explicit in the evaluation process.

The work introduces an expert-annotated benchmark of **more than 18,000 Chinese–English sentence pairs**, a reasoning-driven multi-agent evaluator called **AgentEval**, and **MetricAlign**, a meta-evaluation benchmark containing **1,440 pairs**. Together, the data and evaluation framework help identify specific limitations rather than relying solely on an overall ranking.

Evaluation of **14 translation systems** finds that frontier language models perform strongly overall, but their gains vary by dimension. Zero-pronoun resolution remains a prominent difficulty. The results motivate closer examination of implicit references, context and cultural expressions when assessing translation systems.

### DITING Poster Presentation

The conference poster presented translation examples, the six-dimensional framework, data construction and key experimental findings. Connecting concrete examples with evaluation criteria helped explain how cultural meaning can be studied through annotation and model assessment.

<figure>
  <img src="/news/2026/emnlp-diting-poster.png" alt="DITING poster presentation at EMNLP 2026" loading="lazy" />
  <figcaption>DITING poster presentation at EMNLP 2026</figcaption>
</figure>

**Authors (in paper order):** Enze Zhang, Jiaying Wang, Mengxi Xiao, Jifei Liu, Zhiwei Hu, Ziyan Kuang, Rui Dong, Youzhong Dong, Mohsinul Kabir, Victor Gutierrez-Basulto, Min Peng, Qianqian Xie, Sophia Ananiadou.

- [Published paper](https://aclanthology.org/2026.emnlp-main.1959/)
- [Code and data](https://github.com/whunextgen/DITING)

## SiMing-Bench: Assessing Clinical Procedural Correctness

**Paper:** [SiMing-Bench: Evaluating Procedural Correctness from Continuous Interactions in Clinical Skill Videos](https://aclanthology.org/2026.emnlp-main.2203/)

Clinical skill assessment requires judgments about an entire workflow. Recognizing an action or its temporal order provides only part of the evidence: an evaluator must also understand how interactions change the current procedural state and affect the correctness of later actions.

**SiMing-Bench** uses real clinical examination videos covering **cardiopulmonary resuscitation, automated external defibrillator operation and bag-mask ventilation**. Its accompanying dataset, **SiMing-Score**, combines full-length videos with standardized step-wise rubrics and dual-expert annotations.

The evaluation considers overall scores, step-level judgments and the identification of correct and incorrect steps. This helps distinguish agreement on an overall procedure from reliable understanding of its intermediate steps.

Across open- and closed-source multimodal language models, the study finds weak agreement with physicians' judgments. Apparently acceptable procedure-level correlations can coexist with poor performance on individual steps. The findings highlight the need to model continuous interactions and evolving procedural states in professional video assessment.

### Oral Presentation by Xiyang Huang

Xiyang Huang presented the motivation, clinical evaluation setting and experimental results of SiMing-Bench in an oral talk at EMNLP 2026. The presentation examined agreement with expert assessments at both overall and step levels, and the limitations that coarse evaluation can conceal.

<figure>
  <img src="/news/2026/emnlp-xiyang-huang-oral.png" alt="Xiyang Huang presents SiMing-Bench in an oral talk at EMNLP 2026" loading="lazy" />
  <figcaption>Xiyang Huang presents SiMing-Bench in an oral talk at EMNLP 2026</figcaption>
</figure>

**Authors (in paper order):** Xiyang Huang, Jiawei Lin, Keying Wu, Jiaxin Huang, Kailai Yang, Renxiong Wei, Cheng Zeng, Jiayi Xiang, Ziyan Kuang, Min Peng, Qianqian Xie, Sophia Ananiadou.

- [Published paper](https://aclanthology.org/2026.emnlp-main.2203/)
- [Preprint](https://arxiv.org/abs/2604.09037)

## Conference Links

- [EMNLP 2026](https://2026.emnlp.org/)
- [Accepted main-conference papers](https://2026.emnlp.org/program/main_papers/)
