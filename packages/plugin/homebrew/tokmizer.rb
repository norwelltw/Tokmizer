class Tokmizer < Formula
  desc "Cuts the tokens your AI coding agent burns on command output"
  homepage "https://tokmizer.com"
  url "https://registry.npmjs.org/@tokmizer/plugin/-/plugin-1.0.0.tgz"
  sha256 "9f368e757696acb507fe42d204008e6e90760df16c1324301f81f4fd9ecea26e"
  license all_of: ["Apache-2.0", "BUSL-1.1"]

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match "Usage: tkr", shell_output("#{bin}/tkr help")
  end
end
