// Seeded RNG (mulberry32) - để mọi người chơi trong cùng 1 phòng tạo ra
// đúng 1 chuỗi cột giống hệt nhau từ cùng 1 seed do server phát, mà không
// cần server phải gửi vị trí từng cột qua mạng.

function createSeededRandom(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
