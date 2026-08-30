import { describe, expect, it } from 'vitest'
import {
  fillBibliographyFromRaw,
  mergeParsedBibliography,
  parseBibliography
} from './bibliographyParser'

describe('bibliography parser', () => {
  it('parses a CNKI/GB-T 7714 journal citation', () => {
    expect(
      parseBibliography(
        '王明,李华. 海洋牧场空间分布及其影响因素[J]. 海洋学报,2024,46(3):101-118. DOI:10.1234/example.2024.3'
      )
    ).toMatchObject({
      format: 'gbt7714',
      title: '海洋牧场空间分布及其影响因素',
      authors: '王明,李华',
      year: 2024,
      journal: '海洋学报',
      volume: '46',
      issue: '3',
      pages: '101-118',
      doi: '10.1234/example.2024.3'
    })
  })

  it('parses BibTeX without contacting a network service', () => {
    expect(
      parseBibliography(`@article{inkstone,
        author = {Chen Ming and Lin Qiu},
        title = {Material Memory},
        journal = {Historical Studies},
        year = {2023},
        volume = {18},
        number = {2},
        pages = {44--67},
        doi = {10.5555/inkstone.2023}
      }`)
    ).toMatchObject({
      format: 'bibtex',
      title: 'Material Memory',
      authors: 'Chen Ming；Lin Qiu',
      year: 2023,
      journal: 'Historical Studies',
      volume: '18',
      issue: '2',
      pages: '44-67',
      doi: '10.5555/inkstone.2023'
    })
  })

  it('parses repeated RIS authors and page boundaries', () => {
    expect(
      parseBibliography(`TY  - JOUR
TI  - A Local Research Desk
AU  - Zhang, San
AU  - Li, Si
PY  - 2022/06/01
JO  - Digital History
VL  - 9
IS  - 4
SP  - 12
EP  - 29
DO  - 10.1000/ris.test
ER  -`)
    ).toMatchObject({
      format: 'ris',
      authors: 'Zhang, San；Li, Si',
      year: 2022,
      journal: 'Digital History',
      pages: '12-29'
    })
  })

  it('removes a leading citation number from a CNKI citation', () => {
    expect(
      parseBibliography(
        '[1]陈希丰.南宋蜀口军事防御体系的空间格局及特征[J].中国边疆史地研究,2025,35(4):30-45+215.'
      )
    ).toMatchObject({
      format: 'gbt7714',
      authors: '陈希丰',
      title: '南宋蜀口军事防御体系的空间格局及特征',
      journal: '中国边疆史地研究',
      year: 2025,
      volume: '35',
      issue: '4',
      pages: '30-45+215'
    })
  })

  it('parses EndNote tagged text', () => {
    expect(
      parseBibliography(`%0 Journal Article
%A 陈明
%A 李华
%T 地方社会与物质记忆
%J 历史研究
%D 2021
%V 8
%N 2
%P 44-61
%R 10.1234/endnote.test`)
    ).toMatchObject({
      format: 'endnote',
      authors: '陈明；李华',
      title: '地方社会与物质记忆',
      journal: '历史研究',
      year: 2021,
      volume: '8',
      issue: '2',
      pages: '44-61',
      doi: '10.1234/endnote.test'
    })
  })

  it('parses a common APA journal citation', () => {
    expect(
      parseBibliography(
        'Chen, X. F. (2024). Material memory in local society. Historical Studies, 18(2), 44–67. https://doi.org/10.5555/apa.2024'
      )
    ).toMatchObject({
      format: 'apa',
      authors: 'Chen, X. F',
      title: 'Material memory in local society',
      journal: 'Historical Studies',
      year: 2024,
      volume: '18',
      issue: '2',
      pages: '44-67',
      doi: '10.5555/apa.2024'
    })
  })

  it('fills empty form fields automatically without overwriting manual corrections', () => {
    const value = {
      title: '手工修正后的标题',
      authors: '',
      year: '',
      journal: '',
      volume: '',
      issue: '',
      pages: '',
      doi: '',
      publisher: '',
      metadataRaw: '[1]陈希丰.原始标题[J].中国边疆史地研究,2025,35(4):30-45.'
    }

    expect(fillBibliographyFromRaw(value)).toMatchObject({
      title: '手工修正后的标题',
      authors: '陈希丰',
      year: '2025',
      journal: '中国边疆史地研究',
      volume: '35',
      issue: '4',
      pages: '30-45'
    })
    expect(
      mergeParsedBibliography(value, parseBibliography(value.metadataRaw)!, true)
    ).toMatchObject({ title: '原始标题', authors: '陈希丰' })
  })
})
