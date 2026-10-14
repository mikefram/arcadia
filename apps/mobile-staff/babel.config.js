// babel-preset-expo biên dịch cả mã TypeScript của các gói @mihato/* nằm ngoài thư mục app.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
  };
};
