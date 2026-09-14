<div align="center">
  <img src="public/clain_logo_full.png" alt="CLAIN — Cognitive Language and Information Lab" width="520" />
  <p><strong>Cognitive Language and Information Lab · Wuhan University</strong></p>
  <p>
    <a href="https://clain.org/">Website</a> ·
    <a href="https://clain.org/portal/">Research Portal</a> ·
    <a href="https://github.com/whunextgen/whunextgen.github.io">GitHub</a> ·
    <a href="https://huggingface.co/NextGenWhu">Hugging Face</a>
  </p>
</div>

# CLAIN Lab website

This is the public home of the **Cognitive Language and Information Lab (CLAIN)** at the School of Artificial Intelligence, Wuhan University. The site introduces our people and research, shares publications and news, and provides a starting point for collaboration.

> 认知语言与信息实验室（CLAIN）隶属于武汉大学人工智能学院。我们关注语言、知识与智能的交叉研究，推动人工智能技术在真实世界中的可靠应用。

## Our mission

CLAIN is a collaborative research community led by Professors **Min Peng** and **Qianqian Xie**. We study how language, knowledge, and intelligent systems can work together to help people understand information and make better decisions. Our work connects foundational research with responsible applications in science, healthcare, finance, and society.

## Research themes

- Natural language processing, information retrieval, and knowledge graphs
- Large language models, reasoning, controllability, and evaluation
- Multimodal learning and intelligent agents
- Medical AI, financial AI, social computing, and other knowledge-intensive applications

Our projects are interdisciplinary by design. We work with researchers, institutions, and industry partners who share an interest in reliable, useful, and human-centered AI.

## Explore CLAIN

| Area | Where to find it |
| --- | --- |
| Lab introduction and featured work | [Home / About](https://clain.org/) |
| Faculty, students, and alumni | [People](https://clain.org/#/people) |
| Papers and technical reports | [Publications](https://clain.org/#/publications) |
| Research updates and events | [News](https://clain.org/#/news) |
| Collaboration and recruitment | [Contact](https://clain.org/#/contact) |
| Finance and operations portal | [clain.org/portal](https://clain.org/portal/) |

## Canonical public addresses

These are the official public URLs for the lab website and the finance portal:

| Service | Canonical URL | Use |
| --- | --- | --- |
| Main site | **[https://clain.org/](https://clain.org/)** | Lab profile, people, publications, news, and contact |
| Finance portal | **[https://clain.org/portal/](https://clain.org/portal/)** | Research finance, budget, and API request workflows |

For users connecting from mainland China, the finance portal is also available at [https://finance-portal-79i.pages.dev/](https://finance-portal-79i.pages.dev/). It is an alternate access endpoint to the same finance service: both addresses use the same authentication, Cloudflare Worker, and Feishu data source. They do not represent separate systems or separate datasets.

## Join the community

We welcome research collaborations, visiting scholars, and talented PhD students, master's students, and research interns. If you are interested in working with us, please visit the [Contact page](https://clain.org/#/contact) or write to [plumjane1225@gmail.com](mailto:plumjane1225@gmail.com).

For website corrections and accessibility suggestions, please open an issue in the [website repository](https://github.com/whunextgen/whunextgen.github.io). Keep proposed changes focused and describe the page or section affected.

## Editing the website content

All site content lives in plain files under [`content/`](content/) and is edited through
**Decap CMS** at <https://clain.org/admin/> (sign in with a GitHub account that has write
access to this repository). Every save becomes a commit on `main`; GitHub Actions rebuilds
and redeploys the site within a couple of minutes.

| Content | Where it is stored |
| --- | --- |
| News (English + Chinese) | `content/news/en/*.md`, `content/news/zh/*.md` |
| People | `content/people/*.yml` |
| Publications | `content/publications/*.yml` |
| Projects | `content/projects/*.yml` |
| About / contact / partners / hero images | `content/contact.yml` |
| Uploaded images | `assets/` (referenced as `./assets/<file>`) |

The files can also be edited directly on GitHub or in a local checkout. Local development:

```bash
npm install
npm run dev          # site at http://localhost:5173
npm run cms:local    # optional: lets http://localhost:5173/admin/index.html edit files without GitHub login
```

The CMS login is handled by the small Cloudflare Worker in [`cms-oauth/`](cms-oauth/README.md).

## Repository notes

The website is maintained in English and Chinese. Research and people profiles are curated with the lab team; please contact us before reusing photographs, biographies, or other site content.

## Contact

- General collaboration: [plumjane1225@gmail.com](mailto:plumjane1225@gmail.com)
- Admissions and visiting students: [plumjane1225@gmail.com](mailto:plumjane1225@gmail.com)
- Lab address: School of Artificial Intelligence, Wuhan University, 299 Bayi Road, Wuchang District, Wuhan, Hubei, China

Unless a subdirectory or asset states otherwise, the website source is maintained by CLAIN Lab, Wuhan University. Please contact the lab before redistributing site content, profiles, or photographs.
