// All Korean UI strings of the diagram mode in one table, so a language toggle can be added later.
// Final Korean copy is written by Gemini (see briefs/sitelaser_ko_strings.md); these are temporary names.
export const KO = {
  titles: {
    "01": "항공사진", "02": "건물", "03": "건물 용도", "04": "건축 연도(DB 등록일)", "05": "건물 높이",
    "06": "고층 건물", "07": "저층 건물", "08": "PLU 용도지역", "09": "녹지·수계", "10": "수목",
    "11": "지역지구·보호구역", "12": "도시계획 예정부지", "13": "도로", "14": "대중교통",
    "15": "도보 등시간권", "16": "도시 블록(가구)", "17": "건폐율", "18": "지형·등고선", "19": "경사도",
    "20": "지적도", "21": "필지 규모", "22": "일조", "23": "천공률(SVF)", "24": "바람장미(풍배도)",
    "25": "가로 선택도(Space Syntax)", "26": "가시권", "27": "가로 D/H", "28": "경사향"
  },
  themes: [
    ["all", "전체"], ["building", "건물·형태"], ["env", "환경·지형"], ["street", "교통·가로"], ["rules", "규제·필지"]
  ],
  themeOf: {
    "01": "building", "02": "building", "03": "building", "04": "building", "05": "building", "06": "building", "07": "building", "17": "building",
    "09": "env", "10": "env", "18": "env", "19": "env", "22": "env", "23": "env", "24": "env", "26": "env", "28": "env",
    "13": "street", "14": "street", "15": "street", "16": "street", "25": "street", "27": "street",
    "08": "rules", "11": "rules", "12": "rules", "20": "rules", "21": "rules"
  },
  ui: {
    detail: "상세", detailTitle: "A3 다이어그램", close: "닫기", lineWeight: "선 두께", retry: "다시 시도",
    openCard: "다이어그램 상세 보기", analysis: "대지 분석 보기 · 3D · 일조 · 바람 · 단면 ›", back: "‹ 이전",
    backToSettings: "‹ 설정으로", backToSite: "‹ 대지 선택으로", backToSheets: "‹ 다이어그램 목록",
    pending: "준비 중", loading: "조회 중", failed: "불러오기 실패"
  }
};
export const koTitle = num => KO.titles[num] || num;
