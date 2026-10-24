/*
 * Matrix Music — 示例谱
 *
 * 一首《团子大家族》，分两份代码：
 *
 *   code       全曲，15 段拼接而成（0~896 列 / 785 音 / 4 分 29 秒 @50BPM）。
 *              **只在大面板生效** —— 16 列面板装不下 897 列，只能留下 9 个音，
 *              薄得听不出是首曲子。
 *   codeSmall  64 列节选（开头 16 拍），给 16 列面板用。20 个音，正好铺满一屏。
 *
 * `app.js` 的 loadPreset 按 `RUNTIME.scrollX` 挑：能横向平移的面板拿全曲，
 * 定宽面板拿节选。两份代码都是同一首，只是长度不同。
 *
 * 全曲是怎么来的：用户自己在大面板上分段排好，按拍号贴回原位拼起来的
 * （1 拍 = 4 列，每段 16 拍 = 64 列，其中 161~192 拍是「= 145~160」的引用）。
 * 音域 61~102，全部落在 48 行半音阶内，精确命中、零对齐。
 *
 * 为什么存成**代码字符串**而不是 JS 里的坐标表：
 *   1. 走的是和「别人发你的谱子」完全同一条解码路径（`TM.Store.applyCode`），
 *      预设不可能和分享行为不一致；
 *   2. 想改一个音，改字符串就行，不用碰逻辑；
 *   3. `TM.Store.decode(code)` 随时能把内容摊开看，方便核对。
 *
 * 调这些示例时的约束：
 *   - 只用面板音阶内的音（16 行面板是 C–D–F–G–A）；
 *   - 低音尽量不低于 D4（62）；C4 会被大面板就近对齐（大面板下限 61）；
 *   - 改完用 `TM.Store.decode()` 验证往返，并对照 large-config 音表确认落位。
 */
(function (global) {
  'use strict';

  var TM = global.TM || (global.TM = {});

  /**
   * id    仅作标识
   * name  chip 上的文字（要短）
   * hint  hover 提示：一句话说清「这段是什么、听什么」
   * code  MM3 代码（音符 + 速度 + 音量 + 回环区间）
   */
  TM.PRESETS = [
    {
      id: 'dango',
      name: '团子',
      hint: '团子大家族全曲（15 段拼接，897 列 / 4 分半）；16 列面板载入开头 64 列节选',
      code: 'MM3.PYiMYiHQxGAyGgsERugZbLYwFhbHIyLpdiAxiA5GEUiAyjA1jZbhERj8VLY2jA3kA4lEggsYHMtjsjlsijMtk8RiclGI3jEancrmclGUPoUcmQ5lNDmtKjk4HMwodBHMkiAzpE6qwzn0gGc1qpbGdPsAzqdNkNFpMgGlIqMQGlftdPn9vqdZkI5rklGtpsA1pF-pkgGtjkA2kWHFg4ukmGsQG44w04HAzw1BG0rykgG9FHFgG8yG1bz2bkQ4s43nGYxWVkuQx-RkuLiGJxcqi5byEqmWa2WIzOtiA4ydgHGX0dgjPCs8Sx8P0klHOqhG26M93OxjFB3sWGFF1fcLcF3lgguI5EtGGTs8Fy_Alsu7Hw0PUxgxGNb-U7GOm4PiGLVPe_btvKojHou8IYoO5yYsu-qYry_SLBmzr_Pw0MBQm0zyrE2j0J2srlpo78MvEtjYJoxEHp2GjHQlEzJwsGj3NYlq-OE8q_w8xUctM9jCOdHibu_FaLBs3DdJ2GzeQsxKTRLADiJu48hJ2zkRStDEayskUkos1LaSK8QbuvL0xu3CzZyfLaLBw8iWhxLsETSoLOJa5qTLy407vy087v7O8XOqizpMfCykuFQ8CTvCNBi2oiihvOaQKImUzKIxCT0cokY0oGEaT2oYYUas4ZPi8NTNxTcFQPSj8UTV0N1dQTGVMnFJTZR4YsuG1KQNJ9fUsGNfMRPTs0eGVBVKGVOqGGTr02GU6v8GQZUbakKRxSgZ1VWqrwPXIZK9FChw6k1NW9NFKBpEgWUuGk-2ouDH16pcy3qjkZ3JfMItTSkbxfZMkXxR8dJMrYb2oGr80uGtM3CGtBLBZLpyqjga3UoYa0bWobXbSVKSPWChyXbWST7UsnNEFgbJOm2SYlkL15DGlcVQG1-2PZ8K0pXAtugjjQNok7wYmG9AKGG9aZ7AN3WHpNoaNjOgwjl6OTU1ebVLOLaJ7K-E0oz190e4eh3C0-TavB2LUe5Wf2oHNu0pPGs6ejgc3judZKGqksbu1St5aFmrbbqO5u2s8KY_SaSwo3i7woxEEMZCjVbssIYOu2vKU_s03K7Ucwq6-ObP9bkkOfyFWJNy9uPzwTw25LvKBjF2QcbAEd7B3Ey2PbleVzblGrJX7a-JJiu3E4XKQXNfbqtZOR-hKXG2fvyw2ls3CKv4au2zn_E2_53GK1hnfXHt_vZjxtzaL72prCGeOK7djaJX56whpVSyRP9PG3gXoqy801p-f-rd1q-jckPd3AJnJXWAOwdMDV_cDz6NsBmw56RYWIvLge01_EGFoQSUW41jb1yxHfZc5RkTPyyMlfAV1lT93yFhcEz9yBqyTJiLEhFI5XUrusZYDSH5oVNOQaOjt2LSjhRHhFD845XU1Qga5C2KKgnTNlZ-5RtD_irHGbSWEHC1yutue23F667DOlgXYqo_y7FLLHXY3kkq7G9lvBhFctZ6oAloWgWd_T1C3k8g0_o7ZjH9Rjjor9oBIVTSEWrHwtjKC1vZi6SF78jF4PIjouZz8dH6xaLXANMxcFpyiX65dFqJC1wTVbHRg0DCQsLlcW-DKL0Wu2jWk6WINAbO2lTDZlpckyzAlNHRnEtCQxAlIz5pRa2hG5jcmA3MqYpRuBwkiaqGC1mUmSjNLs15fzcVvHGLkzo6J4fwDRQs0S1qIdZO5Xk7l-mML4pE_xfHUGDIM2MvjDC_AwNMXeCZMjxmDebLEv7tljl_WaRAv7hi9yVeMYOTE-FuQdL2-JutFY50PfRIxhayqKuAZZCqitEaPuIMHKBuquWHJIoY_08LDk-mBYe-4vcvYNMOWhPWBNHKdPdL2wCmkrSIz1YNS6AtD0gEma9AufANXemDYw56qVQ6HseTC2wwkm6tJ9nrDJpxg5fU8htSEG0fqypUcE4QwlWQt1TM6WeqaWnSmDiRDevLljFT1NfPAvYN4epiYxCkxVA5sOiL2m5cFNJuwKsQYOKkPrGIugjZNW89ZzOXYwlShMYp-tuswXuM8VbSwWpCDlpFD2-yhtLB-zs76aA5hJa1UhhjvI7rcYxj0FCSseN4Wdjxv2nK5Y9Qu3NDiTOZjAx54FOTaKnP8kduVwHV1BulTYwx_INJHRc4RI9sTFXDeLVBd11JHIvSXEW47yrTm0ebRS4CzLvPWtffFmrl0lyJQ9Gow1GIYXAo24Gk-A7t4DR9gC8Z4TRHbLuYc77kzDP9sqmF16YjDsPk8mGy8Q7gU7mpccGiZXU4UMvfuddVzDMATtcCo7-JfGhYRdSWd65bWkNpBy-BjWKyMl8_CXz87gVbfGZKNpkk35EknkQ89JnB29rNjxlrM8iX6uPMi9cQMGs-x_NBwV0an2sqe0u4E07s1PpTU_INg4-GYcXeQyxiLzyxMxcm4EWccpPzUZhteP23YNtMo5nFd79t4u9au51rqmJ5pLbww1sywM4pWa63T41cmcceZugN0q_abctptzSYjOPAw5Aqwhm3SQ0Uk6iyRrrsOXUk69TR_lJOz1TOLV9JZYqSqpq_UutQY1xNAkRthoKvm5veo40FxX8Ggjya6-uPDQVr2jW3Axj1rRgYTXQzdG4Z6YBm-bb2Y2EvrUMapohmTPohkswnIZj6WwzNLb_eOyGjn5cI0fZqCDUVAzprXFSL2lWHPC0repualHUM_Lbg2O9l1OzQ0qJxrqrbThNgJeh38C5QM3CyRhqbhce35pitBdzU4o08a6IGFjcs-MOZvL8RuY4Y5inLTES7I6mTJX0iXMXNa047ysqZn01FUM3Y0iJqIqFqNdFkqHSOiGbjKYywZWOp756rokoxuZ2dHNdbUlhstLdNeWW0lWnOuGLLt2hqpjJsF9NuYA25gjZO56UbcqZbob9xNlJCpBuyal3TdeDt-0uvxM6kbJ7_ZW39zN8Wnwb-o-Jx8ecKAfiGf4h8anEsxKmAdQNkwbzJnia9vqdz70R13CGe8UcLIvpIX-cSd7Mp_ezh-ufB1c2TCfKV69JNP4HnjZdGLOcbs_xC4_ELmSqL5Ofm9uJVGU4qePSdb8514khFQRBpIWDoh4Ig3h1DoQOMRJwRBiDgG0gaNwRB2DeGwgZBQYB9',
      codeSmall: 'MM3.PYiMYiHQ2GgsERugZbLYwFhbgosHA1Lpdhwyhw4GcUhwzjAwjZbg0PHAsG4xkA1jEaisPjETlg3jA3kEkh8dGw2Fg5j8sHMukAxhpbHEzlgxi8jkoxiMrhwxjpbG44oEijNAlNDl9OnMPnI2kkSoE1q1Gn1DnkWoVfpUgGVLrNtpFki1QndtkVrk0RosWmo2mI3ho3ppbGVmqUgGdqnNzLYzt9hlgzpEQyMcquEGdYHFox1cvMnyUxoeZsdax1mokgGlqm85u0sGmQ040uV8kN4kl6xo0rg4GWrv1LzkotWhhw1t-Vzo1ymM4EsGtQgsokW7wg1rGBiPQ5Gf45bGujnFMlE1wMow_gG2tkuEG1vxEsG3O8vzqGRioiNMJHUNEQ3jqOiBhsjoRDEOA2oGGr_jsN42IGoIYD6A'
    }
  ];
})(typeof window !== 'undefined' ? window : this);
