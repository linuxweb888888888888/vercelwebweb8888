FROM phemextradebot/bitcointradebot

EXPOSE 80 443 3000

ENV script=adbot

CMD /bin/bash /start
